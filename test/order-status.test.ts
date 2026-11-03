import { describe, expect, it } from "vitest";
import { testActuator } from "@actuate/cli/testing";
import actuator from "../order-status/actuator.js";

const webhook = { trigger: "webhook" } as const;
const mcp = { trigger: "mcp" } as const;
const order = (orderId: string, extra: Record<string, unknown> = {}) => ({
  order: { orderId, email: "Aina@Example.com", status: "shipped", total: 42.5, items: "2x Kopi O beans", trackingUrl: "https://track.test/1", ...extra },
});
const setup = (config: Record<string, unknown> = {}) => testActuator(actuator, { config, now: "2026-11-02T00:00:00Z" });

describe("order-status", () => {
  it("looks up one order by id and email, without the email in the result", async () => {
    const t = setup();
    expect((await t.start(order("A1"), webhook)).output).toEqual({ found: false, orders: [], recorded: true });
    const run = await t.start({ email: "aina@example.com", orderId: "A1" }, mcp);
    expect(run.output).toEqual({
      found: true,
      recorded: false,
      orders: [
        {
          orderId: "A1", status: "shipped", total: 42.5, currency: "MYR", items: "2x Kopi O beans",
          trackingUrl: "https://track.test/1", updatedAt: "2026-11-02T00:00:00.000Z",
        },
      ],
    });
    expect(t.steps(run.runId)).toEqual([]); // a pure read: nothing journaled, nothing written
  });

  it("never returns another customer's order", async () => {
    const t = setup();
    await t.start(order("A1"), webhook);
    expect((await t.start({ email: "someone@else.com", orderId: "A1" }, mcp)).output).toEqual({ found: false, orders: [], recorded: false });
    // Injection attempts are just values that match nothing.
    expect((await t.start({ email: "x@y.co", orderId: "A1' OR '1'='1" }, mcp)).output).toMatchObject({ found: false });
  });

  it("lists recent orders newest first, up to maxResults", async () => {
    const t = setup({ maxResults: 2 });
    for (const id of ["A1", "A2", "A3"]) {
      await t.start(order(id), webhook);
      await t.advance("1 hour");
    }
    await t.start(order("A1", { status: "delivered" }), webhook); // an update moves it to the top
    const run = await t.start({ email: "aina@example.com" }, mcp);
    expect(run.output).toMatchObject({ found: true, orders: [{ orderId: "A1", status: "delivered" }, { orderId: "A3" }] });
    expect(t.rows("orders")).toHaveLength(3);
  });

  it("refuses writes that do not arrive by webhook, so an agent can't edit orders", async () => {
    const t = setup();
    await t.start(order("A1"), webhook);
    expect((await t.start(order("A1", { status: "refunded" }), mcp)).output).toEqual({ found: false, orders: [], recorded: false });
    expect(t.rows("orders")[0]).toMatchObject({ status: "shipped" });
  });

  it("keeps a lookup cheap: one pass, a few rows read through the index, only the run record written", async () => {
    const t = setup();
    for (const id of ["A1", "A2", "A3", "A4"]) await t.start(order(id), webhook);
    const run = await t.start({ email: "aina@example.com", orderId: "A2" }, mcp);
    expect(run.output).toMatchObject({ found: true });
    expect(t.usage(run.runId)).toMatchObject({ passes: 1 });
    expect(t.usage(run.runId).rowsRead).toBeLessThan(20);
    expect(t.usage(run.runId).rowsWritten).toBeLessThan(5);
  });
});

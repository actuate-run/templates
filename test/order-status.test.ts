import { describe, expect, it } from "vitest";
import actuator from "../order-status/actuator.js";
import { HOUR, harness } from "./harness.js";

const webhook = { kind: "webhook" } as const;
const mcp = { kind: "mcp" } as const;
const order = (orderId: string, extra: Record<string, unknown> = {}) => ({
  order: { orderId, email: "Aina@Example.com", status: "shipped", total: 42.5, items: "2x Kopi O beans", trackingUrl: "https://track.test/1", ...extra },
});

describe("order-status", () => {
  it("looks up one order by id and email, without the email in the result", async () => {
    const h = harness(actuator);
    expect((await h.start(order("A1"), webhook)).output).toEqual({ found: false, orders: [], recorded: true });
    const run = await h.start({ email: "aina@example.com", orderId: "A1" }, mcp);
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
    expect(h.manager.getSteps(run.runId)).toEqual([]); // a pure read: nothing journaled, nothing written
  });

  it("never returns another customer's order", async () => {
    const h = harness(actuator);
    await h.start(order("A1"), webhook);
    expect((await h.start({ email: "someone@else.com", orderId: "A1" }, mcp)).output).toEqual({ found: false, orders: [], recorded: false });
    // Injection attempts are just values that match nothing.
    expect((await h.start({ email: "x@y.co", orderId: "A1' OR '1'='1" }, mcp)).output).toMatchObject({ found: false });
  });

  it("lists recent orders newest first, up to maxResults", async () => {
    const h = harness(actuator, { config: { maxResults: 2 } });
    for (const id of ["A1", "A2", "A3"]) {
      await h.start(order(id), webhook);
      await h.advance(HOUR);
    }
    await h.start(order("A1", { status: "delivered" }), webhook); // an update moves it to the top
    const run = await h.start({ email: "aina@example.com" }, mcp);
    expect(run.output).toMatchObject({ found: true, orders: [{ orderId: "A1", status: "delivered" }, { orderId: "A3" }] });
    expect(h.rows("orders")).toHaveLength(3);
  });

  it("refuses writes that do not arrive by webhook, so an agent can't edit orders", async () => {
    const h = harness(actuator);
    await h.start(order("A1"), webhook);
    expect((await h.start(order("A1", { status: "refunded" }), mcp)).output).toEqual({ found: false, orders: [], recorded: false });
    expect(h.rows("orders")[0]).toMatchObject({ status: "shipped" });
  });
});

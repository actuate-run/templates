import { test } from "node:test";
import assert from "node:assert/strict";
import { testActuator } from "@actuate/cli/testing";
import actuator from "./actuator.js";

const order = { orderId: "A1", email: "Aina@Example.com", status: "shipped", total: 42.5, items: "2x Kopi O beans" };

test("saves orders from the shop's webhook and looks them up by email", async () => {
  const t = testActuator(actuator, { now: "2026-11-02T00:00:00Z" });
  assert.deepEqual((await t.start({ order }, { trigger: "webhook" })).output, { found: false, orders: [], recorded: true });

  const run = await t.start({ email: "aina@example.com", orderId: "A1" }, { trigger: "mcp" });
  assert.deepEqual(run.output, {
    found: true,
    recorded: false,
    orders: [{ orderId: "A1", status: "shipped", total: 42.5, currency: "MYR", items: "2x Kopi O beans", trackingUrl: null, updatedAt: "2026-11-02T00:00:00.000Z" }],
  });
  assert.equal(t.steps(run.runId).length, 0); // a pure read: nothing journaled
});

test("never shows another customer's order, and an agent can't write one", async () => {
  const t = testActuator(actuator);
  await t.start({ order }, { trigger: "webhook" });
  const other = await t.start({ email: "someone@else.com", orderId: "A1" }, { trigger: "mcp" });
  assert.deepEqual(other.output, { found: false, orders: [], recorded: false });

  const write = await t.start({ order: { ...order, status: "refunded" } }, { trigger: "mcp" });
  assert.deepEqual(write.output, { found: false, orders: [], recorded: false });
  assert.equal(t.rows("orders")[0]!.status, "shipped");
});

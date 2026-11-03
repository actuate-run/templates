import { test } from "node:test";
import assert from "node:assert/strict";
import { testActuator } from "@actuate/cli/testing";
import actuator from "./actuator.js";

const call = { orderId: "2291", billId: "bill-9", amount: 120, reason: "Arrived broken" };

test("waits for a manager above the threshold, then refunds once", async () => {
  const t = testActuator(actuator);
  const run = await t.start(call);
  assert.equal(run.status, "WAITING");
  assert.equal(t.approvals[0]!.message, "Refund MYR 120.00, order 2291?\nReason: Arrived broken");
  assert.equal(t.refunds.length, 0);

  await t.approve("manager");
  assert.deepEqual(t.run(run.runId).output, { status: "REFUNDED", orderId: "2291", amount: 120, refundId: "refund-1" });
  assert.equal(t.rows("refunds")[0]!.status, "REFUNDED"); // the audit row

  // The agent retries: the same order is never refunded twice.
  const again = await t.start({ ...call, amount: 40 });
  assert.deepEqual(again.output, { status: "ALREADY_REFUNDED", orderId: "2291", amount: 120 });
  assert.equal(t.refunds.length, 1);
});

test("declines, and moves no money, when the manager rejects", async () => {
  const t = testActuator(actuator);
  const run = await t.start(call);
  await t.reject("manager", { note: "Ask for a photo first" });
  assert.deepEqual(t.run(run.runId).output, { status: "DECLINED", orderId: "2291", note: "Ask for a photo first" });
  assert.equal(t.refunds.length, 0);
});

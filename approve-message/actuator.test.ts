import { test } from "node:test";
import assert from "node:assert/strict";
import { testActuator } from "@actuate/cli/testing";
import actuator from "./actuator.js";

const config = { approver: "lead-chat" };
const call = { to: "aina@example.com", draft: "Sorry about the delay. Here is 20% off your next order.", context: "Late delivery, order 2291" };

test("sends nothing until a person approves; a note on approval is their edited message", async () => {
  const t = testActuator(actuator, { config });
  const run = await t.start(call);
  assert.equal(run.status, "WAITING");
  assert.equal(t.messages.length, 0);
  assert.ok(t.approvals[0]!.message?.includes(call.draft)); // the reviewer sees the draft

  await t.approve("human-review", { note: "Sorry about the delay. Here is 10% off your next order." });
  assert.equal(t.messages[0]!.text, "Sorry about the delay. Here is 10% off your next order.");
  assert.deepEqual(t.run(run.runId).output, {
    status: "SENT",
    messageId: run.runId,
    sentText: "Sorry about the delay. Here is 10% off your next order.",
    edited: true,
  });
  assert.equal(t.usage(run.runId).passes, 2); // hibernated while it waited
});

test("never sends a rejected message", async () => {
  const t = testActuator(actuator, { config });
  const run = await t.start(call);
  await t.reject("human-review", { note: "We don't discount for this" });
  assert.deepEqual(t.run(run.runId).output, { status: "REJECTED", messageId: run.runId, edited: false, reviewerNote: "We don't discount for this" });
  assert.equal(t.messages.length, 0);
});

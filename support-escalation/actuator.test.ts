import { test } from "node:test";
import assert from "node:assert/strict";
import { testActuator } from "@actuate/cli/testing";
import actuator from "./actuator.js";

const config = { approver: "manager-chat", supportTeam: "team-chat" };
const ticket = { ticketId: "T-1", customerName: "Aina", contact: "aina-chat", message: "My order arrived broken, please refund", billId: "bill-9", orderAmount: 120 };
const triage = (intent: string, refundAmount: number | null = null) => JSON.stringify({ intent, refundAmount, reply: "ok" });

test("refunds above the threshold only after a manager approves", async () => {
  const t = testActuator(actuator, { config, llm: [triage("refund", 100)] });
  const run = await t.start(ticket);
  assert.equal(run.status, "WAITING");
  assert.match(t.approvals[0]!.message ?? "", /^Refund MYR 100.00 to Aina/);
  assert.equal(t.refunds.length, 0);

  await t.approve("manager-approval");
  assert.deepEqual(t.run(run.runId).output, { outcome: "REFUNDED", amount: 100, refundStatus: "succeeded" });
  assert.equal(t.refunds[0]!.amount, 100);
  assert.match(t.messages.at(-1)!.text, /we've refunded MYR 100.00/);
  assert.deepEqual(t.rows("decisions").map((r) => r.decision), ["classified:refund", "approved", "refund:succeeded"]);
});

test("escalates to the team when the model's reply isn't the JSON it asked for", async () => {
  const t = testActuator(actuator, { config, llm: ["Sorry, I can't help with that."] });
  const run = await t.start(ticket);
  assert.deepEqual(run.output, { outcome: "ESCALATED" });
  assert.deepEqual(t.messages.map((m) => m.to), ["team-chat", "aina-chat"]);
  assert.equal(t.refunds.length, 0);
});

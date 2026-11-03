import { test } from "node:test";
import assert from "node:assert/strict";
import { testActuator } from "@actuate/cli/testing";
import actuator from "./actuator.js";

const config = { humanContact: "support-chat" };
const call = { question: "Can Aina change her delivery address after dispatch?", customerName: "Aina" };

test("opens a ticket, asks a person, and returns their answer", async () => {
  const t = testActuator(actuator, { config });
  const run = await t.start(call);
  assert.equal(run.status, "WAITING");
  assert.equal(t.approvals[0]!.notify, "support-chat"); // gets a signed link to a short form

  await t.advance("1 hour");
  await t.answer("Yes, until 5pm today.", { by: "Siti" });
  assert.deepEqual(t.run(run.runId).output, {
    status: "ANSWERED",
    ticketId: run.runId,
    answer: "Yes, until 5pm today.",
    answeredAt: new Date(t.now()).toISOString(),
    answeredBy: "Siti",
  });
  assert.equal(t.rows("tickets")[0]!.status, "ANSWERED");
});

test("returns TIMED_OUT when nobody answers in time", async () => {
  const t = testActuator(actuator, { config });
  const run = await t.start(call);
  await t.advance("4 hours"); // answerTimeout
  assert.deepEqual(t.run(run.runId).output, { status: "TIMED_OUT", ticketId: run.runId });
  assert.equal(t.rows("tickets")[0]!.status, "TIMED_OUT");
});

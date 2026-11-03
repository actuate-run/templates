import { test } from "node:test";
import assert from "node:assert/strict";
import { testActuator } from "@actuate/cli/testing";
import actuator from "./actuator.js";

const lead = { name: "Mei", email: "mei@example.com", interest: "Do you run group classes?" };

test("emails at once and stops the moment the lead replies", async () => {
  const t = testActuator(actuator, { config: { notifyTo: "sales-chat" } });
  const run = await t.start(lead);
  assert.equal(run.status, "WAITING");
  assert.equal(t.messages[0]!.to, "mei@example.com");
  assert.match(t.messages[0]!.text, /You asked: <i>Do you run group classes\?<\/i>/);

  await t.advance("1 day");
  await t.event(`reply.${run.runId}`, { subject: "Re: Yes please" }); // your inbound-email webhook
  assert.deepEqual(t.run(run.runId).output, { leadId: run.runId, status: "REPLIED" });
  assert.deepEqual(t.messages.map((m) => m.to), ["mei@example.com", "sales-chat"]); // no follow-up
});

test("follows up after two days, and goes COLD after a week of silence", async () => {
  const t = testActuator(actuator);
  const run = await t.start(lead);
  await t.advance("6 days"); // fires both waits on the way
  assert.match(t.messages[1]!.text, /any questions\?/);
  assert.deepEqual(t.run(run.runId).output, { leadId: run.runId, status: "COLD" });
  assert.equal(t.rows("leads")[0]!.status, "COLD");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { testActuator } from "@actuate/cli/testing";
import actuator from "./actuator.js";

const now = "2026-11-02T00:00:00Z";
const call = { contact: "aina-chat", sendAt: "2026-11-05T10:00:00+08:00", message: "Hi Aina, your beans are back in stock!" };

test("sends the exact message at the requested time", async () => {
  const t = testActuator(actuator, { now });
  const run = await t.start(call);
  assert.equal(run.status, "WAITING");

  await t.advanceTo("2026-11-05T01:59:00Z");
  assert.equal(t.messages.length, 0);
  await t.advance("1 minute"); // 10:00 in +08:00
  assert.deepEqual(t.messages.map((m) => [m.to, m.text]), [["aina-chat", "Hi Aina, your beans are back in stock!"]]);
  assert.deepEqual(t.run(run.runId).output, { status: "SENT", followUpId: run.runId, sendAt: "2026-11-05T02:00:00.000Z" });
});

test("is cancelled when the customer replies first", async () => {
  const t = testActuator(actuator, { now });
  const run = await t.start(call);
  await t.event(`reply.${run.runId}`, { text: "Already bought some, thanks" });
  assert.equal(t.run(run.runId).status, "COMPLETED");
  await t.advance("1 week");
  assert.equal(t.messages.length, 0);
  assert.equal(t.rows("follow_ups")[0]!.status, "CANCELLED");
});

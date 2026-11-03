import { test } from "node:test";
import assert from "node:assert/strict";
import { testActuator } from "@actuate/cli/testing";
import actuator from "./actuator.js";

const config = { reportTo: "owner-chat" };

test("records events, then the 09:00 cron sends a summary of the last 24 hours", async () => {
  const t = testActuator(actuator, { config, now: "2026-11-02T06:00:00Z" });
  for (const event of [{ type: "order", amount: 25 }, { type: "order", amount: 15.5 }, { type: "signup" }]) {
    assert.deepEqual((await t.start({ event })).output, { recorded: event.type });
  }
  await t.advanceTo("2026-11-03T01:00:00Z"); // 09:00 in Kuala Lumpur
  const run = await t.cron();
  assert.deepEqual(run.output, { total: 3, sent: true });
  assert.equal(
    t.messages[0]!.text,
    "📊 Daily report, Tuesday, 3 November 2026\n3 events in the last 24 hours (+3 vs the day before)\n• order: 2 (total 40.50)\n• signup: 1",
  );
});

test("skips a quiet day when skipEmpty is set", async () => {
  const t = testActuator(actuator, { config: { ...config, skipEmpty: true } });
  assert.deepEqual((await t.cron()).output, { total: 0, sent: false });
  assert.equal(t.messages.length, 0);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { testActuator } from "@actuate/cli/testing";
import actuator from "./actuator.js";

const now = "2026-11-02T00:00:00Z";
const booking = { customerName: "Aina", contact: "+60123456789", appointmentIso: "2026-11-05T02:00:00Z" };

test("sends a payment link, confirms on payment, and reminds the day before", async () => {
  const t = testActuator(actuator, { now });
  const run = await t.start(booking);
  assert.match(t.messages[0]!.text, /Please pay the MYR 50.00 deposit to confirm: https:\/\/pay\.test\//);

  await t.pay(run.runId); // the payment provider's webhook, for the bill this run created
  assert.match(t.messages[1]!.text, /is confirmed/);
  assert.equal(t.rows("bookings")[0]!.status, "CONFIRMED");

  await t.advance("3 days"); // sleeps until 24 hours before the appointment
  assert.match(t.messages[2]!.text, /^See you tomorrow, Aina!/);
  assert.deepEqual(t.run(run.runId).output, { status: "REMINDED", bookingId: run.runId });
});

test("reminds once, then releases the slot if the deposit never arrives", async () => {
  const t = testActuator(actuator, { now });
  const run = await t.start(booking);
  await t.advance("26 hours"); // reminderDelay (2 hours), then holdAfterReminder (24 hours)
  assert.deepEqual(t.run(run.runId).output, { status: "EXPIRED", bookingId: run.runId });
  assert.equal(t.messages.length, 3);
  assert.match(t.messages[1]!.text, /^Reminder: your MYR 50.00 deposit/);
  assert.match(t.messages[2]!.text, /has been released/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { testActuator } from "@actuate/cli/testing";
import actuator from "./actuator.js";

const config = { alertTo: "finance-chat" };
const webhook = { provider: "chip", billId: "bill-1", referenceId: "order-42", amount: 50, currency: "myr", status: "paid" };

test("matches a paid webhook against the expected amount", async () => {
  const t = testActuator(actuator, { config });
  await t.start({ expect: { referenceId: "order-42", amount: 50 } });
  const run = await t.start(webhook, { trigger: "webhook" });
  assert.deepEqual(run.output, { recorded: "payment", billId: "bill-1", verdict: "matched", duplicate: false });
  assert.equal(t.rows("payments")[0]!.currency, "MYR");
  assert.equal(t.messages.length, 0);
});

test("alerts on a mismatch once, however often the provider redelivers", async () => {
  const t = testActuator(actuator, { config });
  await t.start({ expect: { referenceId: "order-42", amount: 80 } });
  await t.start(webhook, { trigger: "webhook" });
  const again = await t.start(webhook, { trigger: "webhook" });
  assert.deepEqual(again.output, { recorded: "payment", billId: "bill-1", verdict: "amount_mismatch", duplicate: true });
  assert.equal(t.rows("payments").length, 1);
  assert.equal(t.messages.length, 1);
  assert.match(t.messages[0]!.text, /paid MYR 50.00, expected MYR 80.00/);
});

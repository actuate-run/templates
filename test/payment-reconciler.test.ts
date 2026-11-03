import { describe, expect, it } from "vitest";
import { testActuator } from "@actuate/cli/testing";
import actuator from "../payment-reconciler/actuator.js";

const webhook = {
  provider: "chip",
  billId: "bill-1",
  referenceId: "order-42",
  amount: 50,
  currency: "myr",
  status: "paid",
  paidAt: "2026-11-02T00:00:00Z",
};
const setup = (config: Record<string, unknown> = { alertTo: "finance-chat" }) => testActuator(actuator, { config });

describe("payment-reconciler", () => {
  it("records an expected payment, then matches the webhook against it", async () => {
    const t = setup();
    expect((await t.start({ expect: { referenceId: "order-42", amount: 50 } })).output).toEqual({
      recorded: "expected",
      referenceId: "order-42",
    });
    const run = await t.start(webhook, { trigger: "webhook" });
    expect(run.output).toEqual({ recorded: "payment", billId: "bill-1", verdict: "matched", duplicate: false });
    expect(t.rows("payments")).toEqual([
      expect.objectContaining({ provider: "chip", bill_id: "bill-1", currency: "MYR", status: "paid", verdict: "matched" }),
    ]);
    expect(t.messages).toHaveLength(0);
  });

  it("is idempotent: a redelivered webhook neither duplicates the row nor re-alerts", async () => {
    const t = setup();
    await t.start({ expect: { referenceId: "order-42", amount: 80 } });
    const first = await t.start(webhook);
    const again = await t.start(webhook);
    expect(first.output).toMatchObject({ verdict: "amount_mismatch", duplicate: false });
    expect(again.output).toMatchObject({ verdict: "amount_mismatch", duplicate: true });
    expect(t.rows("payments")).toHaveLength(1);
    expect(t.messages).toMatchObject([
      { to: "finance-chat", text: expect.stringContaining("amount mismatch: chip bill bill-1 (ref order-42) paid MYR 50.00, expected MYR 80.00") },
    ]);
  });

  it("updates the row when the status changes, and keeps the first paidAt", async () => {
    const t = setup();
    await t.start({ expect: { referenceId: "order-42", amount: 50 } });
    await t.start(webhook);
    const refunded = await t.start({ ...webhook, status: "refunded", paidAt: null });
    expect(refunded.output).toMatchObject({ verdict: "not_paid", duplicate: false });
    expect(t.rows("payments")).toEqual([expect.objectContaining({ status: "refunded", paid_at: webhook.paidAt })]);
  });

  it("flags unexpected payments and currency mismatches", async () => {
    const t = setup();
    expect((await t.start(webhook)).output).toMatchObject({ verdict: "unexpected" });
    await t.start({ expect: { referenceId: "order-7", amount: 50, currency: "SGD" } });
    expect((await t.start({ ...webhook, billId: "bill-2", referenceId: "order-7" })).output).toMatchObject({
      verdict: "currency_mismatch",
    });
    expect(t.messages).toHaveLength(2);
  });

  it("tolerates rounding within the configured slack, and stays quiet without alertTo", async () => {
    const t = setup({ amountTolerance: 0.05 });
    await t.start({ expect: { referenceId: "order-42", amount: 50.04 } });
    expect((await t.start(webhook)).output).toMatchObject({ verdict: "matched" });
    expect((await t.start({ ...webhook, billId: "bill-3", referenceId: "nope" })).output).toMatchObject({ verdict: "unexpected" });
    expect(t.messages).toHaveLength(0);
  });

  it("still records every payment without a messaging provider", async () => {
    const t = testActuator(actuator, { config: { alertTo: "finance-chat" }, providers: { messaging: undefined } });
    expect((await t.start(webhook)).output).toMatchObject({ verdict: "unexpected", duplicate: false });
    expect(t.rows("payments")).toHaveLength(1);
  });

  it("rejects a webhook with an unknown status", async () => {
    await expect(setup().start({ ...webhook, status: "weird" })).rejects.toThrow(/Invalid input/);
  });
});

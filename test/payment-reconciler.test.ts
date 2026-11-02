import { describe, expect, it } from "vitest";
import actuator from "../payment-reconciler/actuator.js";
import { fakeProviders, harness } from "./harness.js";

const webhook = {
  provider: "chip",
  billId: "bill-1",
  referenceId: "order-42",
  amount: 50,
  currency: "myr",
  status: "paid",
  paidAt: "2026-11-02T00:00:00Z",
};

function setup(config: Record<string, unknown> = { alertTo: "finance-chat" }) {
  const fakes = fakeProviders();
  return { ...fakes, h: harness(actuator, { providers: fakes.providers, config }) };
}

describe("payment-reconciler", () => {
  it("records an expected payment, then matches the webhook against it", async () => {
    const { h, sent } = setup();
    expect((await h.start({ expect: { referenceId: "order-42", amount: 50 } })).output).toEqual({
      recorded: "expected",
      referenceId: "order-42",
    });
    const run = await h.start(webhook);
    expect(run.output).toEqual({ recorded: "payment", billId: "bill-1", verdict: "matched", duplicate: false });
    expect(h.rows("payments")).toEqual([
      expect.objectContaining({ provider: "chip", bill_id: "bill-1", currency: "MYR", status: "paid", verdict: "matched" }),
    ]);
    expect(sent).toHaveLength(0);
  });

  it("is idempotent: a redelivered webhook neither duplicates the row nor re-alerts", async () => {
    const { h, sent } = setup();
    await h.start({ expect: { referenceId: "order-42", amount: 80 } });
    const first = await h.start(webhook);
    const again = await h.start(webhook);
    expect(first.output).toMatchObject({ verdict: "amount_mismatch", duplicate: false });
    expect(again.output).toMatchObject({ verdict: "amount_mismatch", duplicate: true });
    expect(h.rows("payments")).toHaveLength(1);
    expect(sent).toEqual([
      { to: "finance-chat", text: expect.stringContaining("amount mismatch: chip bill bill-1 (ref order-42) paid MYR 50.00, expected MYR 80.00") },
    ]);
  });

  it("updates the row when the status changes, and keeps the first paidAt", async () => {
    const { h } = setup();
    await h.start({ expect: { referenceId: "order-42", amount: 50 } });
    await h.start(webhook);
    const refunded = await h.start({ ...webhook, status: "refunded", paidAt: null });
    expect(refunded.output).toMatchObject({ verdict: "not_paid", duplicate: false });
    expect(h.rows("payments")).toEqual([expect.objectContaining({ status: "refunded", paid_at: webhook.paidAt })]);
  });

  it("flags unexpected payments and currency mismatches", async () => {
    const { h, sent } = setup();
    expect((await h.start(webhook)).output).toMatchObject({ verdict: "unexpected" });
    await h.start({ expect: { referenceId: "order-7", amount: 50, currency: "SGD" } });
    expect((await h.start({ ...webhook, billId: "bill-2", referenceId: "order-7" })).output).toMatchObject({
      verdict: "currency_mismatch",
    });
    expect(sent).toHaveLength(2);
  });

  it("tolerates rounding within the configured slack, and stays quiet without alertTo", async () => {
    const { h, sent } = setup({ amountTolerance: 0.05 });
    await h.start({ expect: { referenceId: "order-42", amount: 50.04 } });
    expect((await h.start(webhook)).output).toMatchObject({ verdict: "matched" });
    expect((await h.start({ ...webhook, billId: "bill-3", referenceId: "nope" })).output).toMatchObject({ verdict: "unexpected" });
    expect(sent).toHaveLength(0);
  });

  it("rejects a webhook with an unknown status", async () => {
    await expect(setup().h.start({ ...webhook, status: "weird" })).rejects.toThrow();
  });
});

import { defineActuator, z } from "@actuate/sdk";

export const ConfigSchema = z.object({
  // Who hears about mismatches. Leave empty to only record them in the `payments` table.
  alertTo: z.string().default(""),
  // Rounding slack, in major units, before an amount counts as a mismatch.
  amountTolerance: z.number().min(0).default(0),
});

/** A payment webhook, normalized from Stripe, Chip, ToyyibPay or Billplz. */
const PaymentWebhook = z.object({
  provider: z.string().min(1),
  billId: z.string().min(1),
  referenceId: z.string().min(1),
  amount: z.number().min(0),
  currency: z.string().length(3).toUpperCase(),
  status: z.enum(["pending", "paid", "failed", "expired", "refunded"]),
  paidAt: z.iso.datetime({ offset: true }).nullable().default(null),
});

/** Register what a reference is supposed to pay, so the webhook can be checked against it. */
const ExpectedPayment = z.object({
  expect: z.object({
    referenceId: z.string().min(1),
    amount: z.number().min(0),
    currency: z.string().length(3).toUpperCase().default("MYR"),
  }),
});

export const InputSchema = z.union([ExpectedPayment, PaymentWebhook]);

type Verdict = "matched" | "amount_mismatch" | "currency_mismatch" | "unexpected" | "not_paid";

export default defineActuator({
  name: "payment_reconciler",
  description:
    "Records payment webhooks in SQLite exactly once and reconciles each paid bill against the amount expected " +
    "for its reference, alerting on mismatches. Also accepts {expect: {referenceId, amount, currency}} to register an expected payment.",
  config: ConfigSchema,
  input: InputSchema,
  // Alerts are optional: without a messaging provider the reconciler still records every payment.
  optionalCapabilities: ["messaging"],
  async run(ctx, input, config) {
    await ctx.db.migrate([
      `CREATE TABLE expected_payments (reference_id TEXT PRIMARY KEY, amount REAL NOT NULL, currency TEXT NOT NULL, created_at TEXT NOT NULL)`,
      `CREATE TABLE payments (
         provider TEXT NOT NULL, bill_id TEXT NOT NULL, reference_id TEXT NOT NULL, amount REAL NOT NULL,
         currency TEXT NOT NULL, status TEXT NOT NULL, paid_at TEXT, verdict TEXT NOT NULL, updated_at TEXT NOT NULL,
         PRIMARY KEY (provider, bill_id))`,
    ]);

    if ("expect" in input) {
      const { referenceId, amount, currency } = input.expect;
      await ctx.step.do("save-expected-payment", () =>
        ctx.db.sql`INSERT INTO expected_payments (reference_id, amount, currency, created_at)
          VALUES (${referenceId}, ${amount}, ${currency}, ${new Date().toISOString()})
          ON CONFLICT (reference_id) DO UPDATE SET amount = excluded.amount, currency = excluded.currency`,
      );
      return { recorded: "expected" as const, referenceId };
    }

    const p = input;
    const { verdict, expected } = await ctx.step.do("reconcile", async () => {
      const check = (verdict: Verdict, expected: string | null = null) => ({ verdict, expected });
      if (p.status !== "paid") return check("not_paid");
      const expected = await ctx.db.first<{ amount: number; currency: string }>(
        "SELECT amount, currency FROM expected_payments WHERE reference_id = ?",
        [p.referenceId],
      );
      if (!expected) return check("unexpected");
      const label = `${expected.currency} ${expected.amount.toFixed(2)}`;
      if (expected.currency !== p.currency) return check("currency_mismatch", label);
      return check(Math.abs(expected.amount - p.amount) > config.amountTolerance ? "amount_mismatch" : "matched", label);
    });

    // Providers retry webhooks. A delivery identical to the stored row changes nothing and alerts no one.
    const isNew = await ctx.step.do("upsert-payment", async () => {
      const before = await ctx.db.first(
        "SELECT 1 FROM payments WHERE provider = ? AND bill_id = ? AND status = ? AND amount = ? AND verdict = ?",
        [p.provider, p.billId, p.status, p.amount, verdict],
      );
      await ctx.db.sql`INSERT INTO payments (provider, bill_id, reference_id, amount, currency, status, paid_at, verdict, updated_at)
        VALUES (${p.provider}, ${p.billId}, ${p.referenceId}, ${p.amount}, ${p.currency}, ${p.status}, ${p.paidAt}, ${verdict}, ${new Date().toISOString()})
        ON CONFLICT (provider, bill_id) DO UPDATE SET
          reference_id = excluded.reference_id, amount = excluded.amount, currency = excluded.currency, status = excluded.status,
          paid_at = COALESCE(excluded.paid_at, payments.paid_at), verdict = excluded.verdict, updated_at = excluded.updated_at`;
      return before === null;
    });

    const mismatch = verdict === "amount_mismatch" || verdict === "currency_mismatch" || verdict === "unexpected";
    if (mismatch && isNew && config.alertTo) {
      await ctx.step.do("alert-mismatch", () =>
        ctx.messaging?.send(
          config.alertTo,
          `Payment ${verdict.replace("_", " ")}: ${p.provider} bill ${p.billId} (ref ${p.referenceId}) ` +
            `paid ${p.currency} ${p.amount.toFixed(2)}, expected ${expected ?? "nothing"}. Check the payments table.`,
        ),
      );
    }
    return { recorded: "payment" as const, billId: p.billId, verdict, duplicate: !isNew };
  },
});

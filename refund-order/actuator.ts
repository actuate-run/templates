import { NonRetryableError, defineActuator, parseDuration, z } from "@actuate/sdk";

export const ConfigSchema = z.object({
  currency: z.string().length(3).default("MYR"),
  // Refunds above this need a person. At or below it, the tool refunds on its own.
  approvalThreshold: z.number().min(0).default(50),
  // Hard ceiling. Nothing the agent sends can refund more than this.
  maxRefund: z.number().min(0).default(500),
  approver: z.string().min(1).default("@shop_manager").describe("Chat ID or email that receives the approval link"),
  approvalTimeout: z.enum(["1 hour", "24 hours", "3 days"]).default("24 hours"),
});

export const InputSchema = z.object({
  orderId: z.string().min(1).describe("Your order ID; one refund per order"),
  billId: z.string().min(1).describe("Payment provider bill or payment ID for the order"),
  amount: z.number().positive().describe("Refund amount in major units, e.g. 120 for RM 120.00"),
  reason: z.string().max(500).default("").describe("Why the customer is owed a refund, shown to the approver"),
});

export const OutputSchema = z.object({
  status: z.enum(["REFUNDED", "DECLINED", "ALREADY_REFUNDED", "IN_PROGRESS"]),
  orderId: z.string(),
  amount: z.number().optional().describe("What was actually refunded, after the cap"),
  refundId: z.string().optional(),
  note: z.string().optional().describe("Why it was declined, the approver's note, or which run is already handling the order"),
});

export default defineActuator({
  name: "refund_order",
  description:
    "Refund a customer's order. Call this when a refund is warranted; do not promise a refund before it returns. " +
    "The amount is capped by the business, refunds above a threshold wait for a manager's approval (the call " +
    "then returns status WAITING; poll actuate_get_run), and each order can be refunded only once. " +
    "Returns REFUNDED with the amount actually refunded, DECLINED with a note, ALREADY_REFUNDED, or IN_PROGRESS " +
    "when another call for the same order is still waiting for approval.",
  config: ConfigSchema,
  input: InputSchema,
  output: OutputSchema,
  // messaging delivers the manager's approval link.
  capabilities: ["payment", "messaging"],
  hints: { destructive: true, openWorld: true },
  async run(ctx, input, config): Promise<z.output<typeof OutputSchema>> {
    const { orderId } = input;
    await ctx.db.migrate([
      `CREATE TABLE refunds (order_id TEXT NOT NULL, run_id TEXT NOT NULL, amount REAL NOT NULL, status TEXT NOT NULL,
         refund_id TEXT, note TEXT, at INTEGER NOT NULL)`,
    ]);

    const amount = Math.min(input.amount, config.maxRefund); // hard cap
    const money = `${config.currency} ${amount.toFixed(2)}`;

    // Agents retry and rephrase, and a client without an idempotency key starts a new run for each retry. So the run
    // claims the order first: a PENDING row, written with this step's result. The step does nothing but database work,
    // so no other run can claim the same order in between, and a second call for the order is refused instead of
    // waiting for its own approval and refunding twice. A claim older than the approval timeout plus an hour is stale
    // (its run was cancelled or lost), so it doesn't block the order forever.
    const staleAfter = parseDuration(config.approvalTimeout) + 3_600_000;
    const claim = await ctx.step.do("claim-order", async ({ now }) => {
      const refunded = await ctx.db.first<{ amount: number }>(
        "SELECT amount FROM refunds WHERE order_id = ? AND status = 'REFUNDED'",
        [orderId],
      );
      if (refunded) return { kind: "refunded" as const, amount: refunded.amount };
      const pending = await ctx.db.first<{ run_id: string }>(
        "SELECT run_id FROM refunds WHERE order_id = ? AND status = 'PENDING' AND run_id != ? AND at > ?",
        [orderId, ctx.runId, now - staleAfter],
      );
      if (pending) return { kind: "busy" as const, runId: pending.run_id };
      ctx.db.commitWithStep([ctx.db.statement`INSERT INTO refunds VALUES (${orderId}, ${ctx.runId}, ${amount}, 'PENDING', NULL, NULL, ${now})`]);
      return { kind: "claimed" as const };
    });
    if (claim.kind === "refunded") return { status: "ALREADY_REFUNDED", orderId, amount: claim.amount };
    if (claim.kind === "busy") {
      return { status: "IN_PROGRESS", orderId, note: `Run ${claim.runId} is already handling a refund for this order.` };
    }

    // The claim becomes the audit row. It is updated with its step's result (commitWithStep, inside the step): exactly
    // once, even if the step is retried or the run replayed.
    const auditRow = (status: "REFUNDED" | "DECLINED" | "FAILED", refundId: string | null, note: string | null, at: number) =>
      ctx.db.statement`UPDATE refunds SET status = ${status}, refund_id = ${refundId}, note = ${note}, at = ${at}
                       WHERE order_id = ${orderId} AND run_id = ${ctx.runId}`;

    let note: string | undefined;
    if (amount > config.approvalThreshold) {
      const ok = await ctx.step.waitForApproval("manager", {
        message: `Refund ${money}, order ${orderId}?${input.reason ? `\nReason: ${input.reason}` : ""}`,
        notify: config.approver,
        timeout: config.approvalTimeout,
      });
      note = ok?.note;
      if (!ok?.approved) {
        const why = ok === null ? "No decision before the approval expired." : (ok.note ?? "Rejected by the manager.");
        await ctx.step.do("audit-declined", ({ now }) => ctx.db.commitWithStep([auditRow("DECLINED", null, why, now)]));
        return { status: "DECLINED", orderId, note: why };
      }
    }

    let refund;
    try {
      refund = await ctx.step.do("refund", { retries: 3 }, async ({ now }) => {
        if (!ctx.payment.refund) throw new NonRetryableError("The configured payment provider cannot issue refunds.");
        // The runtime adds an idempotency key derived from this step, so a retry can't refund twice (Stripe honours it).
        const result = await ctx.payment.refund({ billId: input.billId, amount, reason: input.reason || `Order ${orderId}` });
        if (result.status === "failed") throw new Error(`Refund ${result.id} failed at the payment provider.`);
        // Committed with this step's result, so a completed refund is always seen by the once-per-order check.
        ctx.db.commitWithStep([auditRow("REFUNDED", result.id, note ?? null, now)]);
        return result;
      });
    } catch (err) {
      // Release the claim, so the order can be tried again, then fail the run as before.
      const why = err instanceof Error ? err.message : String(err);
      await ctx.step.do("audit-failed", ({ now }) => ctx.db.commitWithStep([auditRow("FAILED", null, why, now)]));
      throw err;
    }
    return { status: "REFUNDED", orderId, amount, refundId: refund.id, ...(note ? { note } : {}) };
  },
});

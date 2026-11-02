import { NonRetryableError, defineActuator, z } from "@actuate/sdk";

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
  status: z.enum(["REFUNDED", "DECLINED", "ALREADY_REFUNDED"]),
  orderId: z.string(),
  amount: z.number().optional().describe("What was actually refunded, after the cap"),
  refundId: z.string().optional(),
  note: z.string().optional().describe("Why it was declined, or the approver's note"),
});

export default defineActuator({
  name: "refund_order",
  description:
    "Refund a customer's order. Call this when a refund is warranted; do not promise a refund before it returns. " +
    "The amount is capped by the business, refunds above a threshold wait for a manager's approval (the call " +
    "then returns status WAITING; poll actuate_get_run), and each order can be refunded only once. " +
    "Returns REFUNDED with the amount actually refunded, DECLINED with a note, or ALREADY_REFUNDED.",
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

    // Agents retry and rephrase. A second refund for the same order is refused, not paid twice.
    const previous = await ctx.step.do("check-previous", () =>
      ctx.db.first<{ amount: number }>("SELECT amount FROM refunds WHERE order_id = ? AND status = 'REFUNDED'", [orderId]),
    );
    if (previous) return { status: "ALREADY_REFUNDED", orderId, amount: previous.amount };

    const amount = Math.min(input.amount, config.maxRefund); // hard cap
    const money = `${config.currency} ${amount.toFixed(2)}`;
    const audit = (step: string, status: string, refundId: string | null, note: string | null) =>
      ctx.step.do(step, ({ now }) =>
        ctx.db.sql`INSERT INTO refunds VALUES (${orderId}, ${ctx.runId}, ${amount}, ${status}, ${refundId}, ${note}, ${now})`,
      );

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
        await audit("audit-declined", "DECLINED", null, why);
        return { status: "DECLINED", orderId, note: why };
      }
    }

    const refund = await ctx.step.do("refund", { retries: 3 }, async (step) => {
      if (!ctx.payment.refund) throw new NonRetryableError("The configured payment provider cannot issue refunds.");
      const result = await ctx.payment.refund({
        billId: input.billId,
        amount,
        reason: input.reason || `Order ${orderId}`,
        idempotencyKey: step.idempotencyKey,
      });
      if (result.status === "failed") throw new Error(`Refund ${result.id} failed at the payment provider.`);
      return result;
    });
    await audit("audit", "REFUNDED", refund.id, note ?? null);
    return { status: "REFUNDED", orderId, amount, refundId: refund.id, ...(note ? { note } : {}) };
  },
});

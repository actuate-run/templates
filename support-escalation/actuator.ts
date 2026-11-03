import { defineActuator, z, type Db, type SqlValue } from "@actuate/sdk";

export const ConfigSchema = z.object({
  businessName: z.string().default("Kedai Kopi Aina"),
  currency: z.string().length(3).default("MYR"),
  // Refunds up to this amount are issued without a human. Above it, a person must approve.
  approvalThreshold: z.number().min(0).default(50),
  // Hard ceiling. No refund above this is ever issued, whatever the model or the approver says.
  maxRefund: z.number().min(0).default(500),
  approver: z.string().min(1).describe("Chat ID or email that receives refund approval links"),
  supportTeam: z.string().min(1).describe("Chat ID or email that receives escalated tickets"),
  approvalTimeout: z.enum(["4 hours", "24 hours", "3 days"]).default("24 hours"),
});

export const InputSchema = z.object({
  ticketId: z.string().min(1),
  customerName: z.string().min(1),
  contact: z.string().min(3).describe("Where to reply: phone, chat ID or email"),
  message: z.string().min(1).max(4000),
  billId: z.string().optional().describe("Payment provider bill ID of the order, needed to refund"),
  orderAmount: z.number().min(0).default(0).describe("What the customer paid; a refund never exceeds it"),
});

// What we accept back from the model. Anything else is treated as "escalate".
const Classification = z.object({
  intent: z.enum(["refund", "question", "complaint", "other"]),
  refundAmount: z.number().min(0).nullable().default(null),
  reply: z.string().max(1000).default(""),
});

type Triage = z.output<typeof Classification>;

/** Pull the first JSON object out of the model's reply. Unparseable output escalates. */
function parseTriage(text: string): Triage {
  try {
    const parsed = Classification.safeParse(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)));
    if (parsed.success) return parsed.data;
  } catch {}
  return { intent: "other", refundAmount: null, reply: "" };
}

async function audit(db: Db, ticketId: string, runId: string, decision: string, amount: number | null, detail: string) {
  const row: SqlValue[] = [ticketId, runId, decision, amount, detail, new Date().toISOString()];
  await db.query("INSERT INTO decisions (ticket_id, run_id, decision, amount, detail, at) VALUES (?, ?, ?, ?, ?, ?)", row);
}

export default defineActuator({
  name: "support_escalation",
  description:
    "Triages a customer support message with an LLM. Answers simple questions, escalates complaints to a human, " +
    "and issues refunds within a hard cap, asking a manager to approve any refund above the threshold.",
  config: ConfigSchema,
  input: InputSchema,
  capabilities: ["llm", "messaging", "payment"],
  async run(ctx, input, config) {
    await ctx.db.migrate([
      `CREATE TABLE decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, run_id TEXT NOT NULL,
         decision TEXT NOT NULL, amount REAL, detail TEXT NOT NULL, at TEXT NOT NULL)`,
    ]);
    const record = (step: string, decision: string, amount: number | null, detail: string) =>
      ctx.step.do(step, () => audit(ctx.db, input.ticketId, ctx.runId, decision, amount, detail));
    const reply = (step: string, text: string) => ctx.step.do(step, () => ctx.messaging.send(input.contact, text));

    const triage = await ctx.step.do("classify-message", { retries: 2 }, async () => {
      const { text } = await ctx.llm.complete({
        system:
          `You triage support messages for ${config.businessName}. Respond with JSON only: ` +
          `{"intent":"refund"|"question"|"complaint"|"other","refundAmount":number|null,"reply":string}. ` +
          `"reply" is a short, friendly answer for "question"; otherwise a one-line acknowledgement.`,
        prompt: `Order amount: ${config.currency} ${input.orderAmount}\nCustomer message:\n${input.message}`,
        maxTokens: 400,
      });
      return parseTriage(text);
    });
    await record("audit-classification", `classified:${triage.intent}`, triage.refundAmount, input.message);

    if (triage.intent === "question" && triage.reply) {
      await reply("send-answer", triage.reply);
      return { outcome: "ANSWERED" as const };
    }

    // The cap is enforced here, in code: the model only proposes a number.
    const amount = Math.min(triage.refundAmount ?? input.orderAmount, input.orderAmount, config.maxRefund);
    if (triage.intent !== "refund" || amount <= 0 || !input.billId) {
      await ctx.step.do("escalate-to-team", () =>
        ctx.messaging.send(config.supportTeam, `Ticket ${input.ticketId} from ${input.customerName} needs a human (${triage.intent}):\n${input.message}`),
      );
      await record("audit-escalation", "escalated", null, triage.intent);
      await reply("acknowledge-customer", `Thanks ${input.customerName}, a member of our team will get back to you shortly.`);
      return { outcome: "ESCALATED" as const };
    }

    const money = `${config.currency} ${amount.toFixed(2)}`;
    if (amount > config.approvalThreshold) {
      const decision = await ctx.step.waitForApproval("manager-approval", {
        message: `Refund ${money} to ${input.customerName} (ticket ${input.ticketId})?\n"${input.message}"`,
        notify: config.approver,
        timeout: config.approvalTimeout,
      });
      const verdict = decision === null ? "approval-timed-out" : decision.approved ? "approved" : "rejected";
      await record("audit-approval", verdict, amount, decision?.note ?? "");
      if (!decision?.approved) {
        await reply("send-refund-declined", `Hi ${input.customerName}, we couldn't approve this refund automatically. Our team will contact you.`);
        return { outcome: "REFUND_DECLINED" as const, amount };
      }
    }

    const billId = input.billId;
    // The runtime gives the refund an idempotency key derived from this step: a retry can't refund twice (Stripe honours it).
    const refund = await ctx.step.do("issue-refund", { retries: 3 }, async () => {
      if (!ctx.payment.refund) return { id: "", status: "manual" as const };
      return ctx.payment.refund({ billId, amount, reason: `Ticket ${input.ticketId}` });
    });
    await record("audit-refund", `refund:${refund.status}`, amount, refund.id);
    await reply(
      "send-refund-confirmation",
      refund.status === "manual"
        ? `Hi ${input.customerName}, your ${money} refund is approved and will be processed by our team.`
        : `Hi ${input.customerName}, we've refunded ${money}. It may take a few days to appear.`,
    );
    return { outcome: "REFUNDED" as const, amount, refundStatus: refund.status };
  },
});

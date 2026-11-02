import { defineActuator, z } from "@actuate/sdk";

export const ConfigSchema = z.object({
  approver: z.string().min(1).describe("Chat ID or email of the person who reviews outgoing messages"),
  approvalTimeout: z.enum(["1 hour", "4 hours", "24 hours"]).default("4 hours"),
});

export const InputSchema = z.object({
  to: z.string().min(3).describe("Recipient: phone number, chat ID or email"),
  draft: z.string().min(1).max(4000).describe("The message you want to send, exactly as the recipient should read it"),
  context: z.string().max(1000).default("").describe("One or two lines for the reviewer: who this is and why"),
  subject: z.string().max(200).optional().describe("Email subject, when the recipient is an email address"),
});

export const OutputSchema = z.object({
  status: z.enum(["SENT", "REJECTED", "EXPIRED"]),
  messageId: z.string(),
  sentText: z.string().optional().describe("What was actually sent; differs from the draft when the reviewer edited it"),
  edited: z.boolean(),
  reviewerNote: z.string().optional(),
});

export default defineActuator({
  name: "approve_message",
  description:
    "Send a message to a customer only after a person approves it. Use it for anything sensitive: apologies, " +
    "price quotes, policy exceptions, or any message you are unsure about. A reviewer sees your draft and approves, " +
    "edits, or rejects it; nothing is sent without approval. Returns WAITING until they decide, then SENT (with the " +
    "text actually sent, which may be edited), REJECTED (with the reviewer's note), or EXPIRED.",
  config: ConfigSchema,
  input: InputSchema,
  output: OutputSchema,
  capabilities: ["messaging"],
  async run(ctx, input, config): Promise<z.output<typeof OutputSchema>> {
    const messageId = ctx.runId;
    await ctx.db.migrate([
      `CREATE TABLE outgoing_messages (id TEXT PRIMARY KEY, recipient TEXT NOT NULL, draft TEXT NOT NULL, sent_text TEXT,
         status TEXT NOT NULL, reviewer_note TEXT, created_at INTEGER NOT NULL, decided_at INTEGER)`,
    ]);
    const decide = (step: string, status: string, sentText: string | null, note: string | null) =>
      ctx.step.do(step, ({ now }) => ctx.db.sql`UPDATE outgoing_messages
        SET status = ${status}, sent_text = ${sentText}, reviewer_note = ${note}, decided_at = ${now} WHERE id = ${messageId}`);

    await ctx.step.do("save-draft", ({ now }) =>
      ctx.db.sql`INSERT INTO outgoing_messages (id, recipient, draft, status, created_at)
        VALUES (${messageId}, ${input.to}, ${input.draft}, 'PENDING', ${now})`,
    );

    const review = await ctx.step.waitForApproval("human-review", {
      message:
        `Message to ${input.to}${input.context ? ` (${input.context})` : ""}:\n\n${input.draft}\n\n` +
        "Approve to send as is. To send an edited version, approve from the dashboard with your text as the note.",
      notify: config.approver,
      timeout: config.approvalTimeout,
    });

    if (review === null) {
      await decide("mark-expired", "EXPIRED", null, null);
      return { status: "EXPIRED", messageId, edited: false };
    }
    const note = review.note?.trim() || undefined;
    if (!review.approved) {
      await decide("mark-rejected", "REJECTED", null, note ?? null);
      return { status: "REJECTED", messageId, edited: false, ...(note ? { reviewerNote: note } : {}) };
    }

    // On approval, a note is the reviewer's edited message. It replaces the draft.
    const text = note ?? input.draft;
    await ctx.step.do("send-message", { retries: 3 }, () =>
      ctx.messaging.send(input.to, text, input.subject ? { subject: input.subject } : undefined),
    );
    await decide("mark-sent", "SENT", text, note ?? null);
    return { status: "SENT", messageId, sentText: text, edited: text !== input.draft };
  },
});

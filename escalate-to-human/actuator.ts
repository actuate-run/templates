import { defineActuator, z } from "@actuate/sdk";

export const ConfigSchema = z.object({
  humanContact: z.string().min(1).describe("Chat ID or email of the person (or team chat) who answers escalations"),
  answerTimeout: z.enum(["15 minutes", "1 hour", "4 hours", "24 hours"]).default("4 hours"),
});

export const InputSchema = z.object({
  question: z.string().min(1).max(4000).describe("What you need a person to answer or decide"),
  customerName: z.string().max(200).default(""),
  context: z.string().max(4000).default("").describe("What you already know or tried, so the human doesn't have to ask"),
  urgency: z.enum(["low", "normal", "urgent"]).default("normal"),
});

export const OutputSchema = z.object({
  status: z.enum(["ANSWERED", "TIMED_OUT"]),
  ticketId: z.string(),
  answer: z.string().optional().describe("The human's answer, verbatim"),
  answeredAt: z.string().optional(),
  answeredBy: z.string().optional().describe("Who answered, if known (a name typed on the form is self-reported)"),
});

export default defineActuator({
  name: "escalate_to_human",
  description:
    "Ask a human when you cannot or should not answer yourself: account-specific questions, judgement calls, " +
    "anything you are not sure is true. Creates a ticket and sends a person a link to answer it. Returns WAITING; " +
    "poll actuate_get_run for ANSWERED with the human's answer (relay it faithfully), or TIMED_OUT, in which case " +
    "tell the customer a person will follow up. Do not invent an answer while waiting.",
  config: ConfigSchema,
  input: InputSchema,
  output: OutputSchema,
  // messaging delivers the answer link.
  capabilities: ["messaging"],
  // Each call opens a new ticket and pings a person, so a repeat is not harmless.
  hints: { openWorld: true },
  async run(ctx, input, config): Promise<z.output<typeof OutputSchema>> {
    const ticketId = ctx.runId;
    await ctx.db.migrate([
      `CREATE TABLE tickets (id TEXT PRIMARY KEY, question TEXT NOT NULL, customer_name TEXT NOT NULL, context TEXT NOT NULL,
         urgency TEXT NOT NULL, status TEXT NOT NULL, answer TEXT, created_at INTEGER NOT NULL, closed_at INTEGER)`,
    ]);

    await ctx.step.do("create-ticket", ({ now }) =>
      ctx.db.sql`INSERT INTO tickets (id, question, customer_name, context, urgency, status, created_at)
        VALUES (${ticketId}, ${input.question}, ${input.customerName}, ${input.context}, ${input.urgency}, 'OPEN', ${now})`,
    );

    // The person gets a signed link to a short form; their text comes back here.
    const reply = await ctx.step.waitForInput("human-answer", {
      prompt:
        `${input.urgency === "urgent" ? "🚨 URGENT: " : ""}An agent needs a human answer (ticket ${ticketId})` +
        `${input.customerName ? ` for ${input.customerName}` : ""}.\n\nQuestion: ${input.question}` +
        `${input.context ? `\n\nContext: ${input.context}` : ""}`,
      notify: config.humanContact,
      maxLength: 2000,
      timeout: config.answerTimeout,
    });
    // Belt and braces: the form refuses blank answers, and the agent never relays one either.
    const answer = reply?.text.trim() ? reply : null;

    await ctx.step.do("close-ticket", ({ now }) =>
      ctx.db.sql`UPDATE tickets SET status = ${answer ? "ANSWERED" : "TIMED_OUT"}, answer = ${answer?.text.trim() ?? null},
        closed_at = ${now} WHERE id = ${ticketId}`,
    );
    if (!answer) return { status: "TIMED_OUT", ticketId };
    return { status: "ANSWERED", ticketId, answer: answer.text.trim(), answeredAt: answer.at, ...(answer.by ? { answeredBy: answer.by } : {}) };
  },
});

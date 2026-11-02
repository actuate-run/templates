import { defineActuator, z } from "@actuate/sdk";

export const ConfigSchema = z.object({
  // The furthest ahead an agent may schedule. Stops a typo'd year from parking a run for a decade.
  maxDaysAhead: z.number().int().min(1).max(365).default(90),
  // Follow-ups closer than this are refused: the agent should just reply now.
  minMinutesAhead: z.number().int().min(0).default(5),
});

export const InputSchema = z.object({
  contact: z.string().min(3).describe("Customer's phone number, chat ID or email"),
  sendAt: z.iso.datetime({ offset: true }).describe("When to send, ISO 8601 with offset, e.g. 2026-11-20T10:00:00+08:00"),
  message: z.string().min(1).max(1000).describe("The exact text the customer will receive"),
});

export const OutputSchema = z.object({
  status: z.enum(["SENT", "CANCELLED", "INVALID_TIME"]),
  followUpId: z.string(),
  sendAt: z.string(),
  reason: z.string().optional(),
});

const DAY_MS = 86_400_000;

export default defineActuator({
  name: "schedule_follow_up",
  description:
    "Schedule a message to a customer at a future time, e.g. 'remind Aina on Friday 10am about her order'. " +
    "Pass the exact text and an ISO 8601 time with a timezone offset. The time must be in the future and within " +
    "the business's limit (default 90 days), otherwise the result is INVALID_TIME with a reason you can fix and retry. " +
    "If the customer replies before then, the follow-up is cancelled. Returns WAITING until it is sent or cancelled.",
  config: ConfigSchema,
  input: InputSchema,
  output: OutputSchema,
  capabilities: ["messaging"],
  hints: { openWorld: true },
  async run(ctx, input, config): Promise<z.output<typeof OutputSchema>> {
    const followUpId = ctx.runId;
    const sendAt = Date.parse(input.sendAt);
    const result = (status: "SENT" | "CANCELLED" | "INVALID_TIME", reason?: string) => ({
      status,
      followUpId,
      sendAt: new Date(sendAt).toISOString(),
      ...(reason ? { reason } : {}),
    });
    await ctx.db.migrate([
      `CREATE TABLE follow_ups (id TEXT PRIMARY KEY, contact TEXT NOT NULL, send_at INTEGER NOT NULL, message TEXT NOT NULL,
         status TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    ]);

    // Validate against the host clock once; the answer is journaled, so replays agree.
    const check = await ctx.step.do("validate-time", ({ now }) => {
      const tooSoon = sendAt < now + config.minMinutesAhead * 60_000;
      const tooFar = sendAt > now + config.maxDaysAhead * DAY_MS;
      const reason = tooSoon
        ? `sendAt must be at least ${config.minMinutesAhead} minutes in the future.`
        : tooFar ? `sendAt must be within ${config.maxDaysAhead} days.` : "";
      return { ok: !reason, reason };
    });
    if (!check.ok) return result("INVALID_TIME", check.reason);

    const setStatus = (step: string, status: string) =>
      ctx.step.do(step, ({ now }) => ctx.db.sql`UPDATE follow_ups SET status = ${status}, updated_at = ${now} WHERE id = ${followUpId}`);
    await ctx.step.do("save-follow-up", ({ now }) =>
      ctx.db.sql`INSERT INTO follow_ups VALUES (${followUpId}, ${input.contact}, ${sendAt}, ${input.message}, 'SCHEDULED', ${now})`,
    );

    // Sleep until sendAt, unless the customer replies first.
    const reply = await ctx.step.waitForEvent("wait-for-reply", { event: `reply.${followUpId}`, until: sendAt });
    if (reply !== null) {
      await setStatus("mark-cancelled", "CANCELLED");
      return result("CANCELLED", "The customer replied first.");
    }

    await ctx.step.do("send-follow-up", () => ctx.messaging.send(input.contact, input.message));
    await setStatus("mark-sent", "SENT");
    return result("SENT");
  },
});

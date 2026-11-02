import { defineActuator, z } from "@actuate/sdk";

export const ConfigSchema = z.object({
  reportTo: z.string().min(1).describe("Chat ID, phone or email that receives the report"),
  title: z.string().default("Daily report"),
  timeZone: z.string().default("Asia/Kuala_Lumpur"),
  topTypes: z.number().int().min(1).max(20).default(5),
  // Skip the message on days with no events, instead of sending "nothing happened".
  skipEmpty: z.boolean().default(false),
});

export const InputSchema = z.object({
  // Omit to send the report (cron runs pass {}). Include to record one event for tomorrow's report.
  event: z
    .object({
      type: z.string().min(1).max(100).describe("e.g. signup, order, refund"),
      amount: z.number().optional().describe("Optional value summed per type, e.g. order total"),
      detail: z.string().max(2000).optional(),
    })
    .optional(),
});

const HOUR_MS = 60 * 60 * 1000;

type TypeRow = { type: string; n: number; total: number | null };

export default defineActuator({
  name: "daily_report",
  description:
    "Every morning at 09:00 Malaysia time, summarises the last 24 hours of recorded events and sends the report. " +
    "Call it with {event: {type, amount?, detail?}} to record an event.",
  config: ConfigSchema,
  input: InputSchema,
  capabilities: ["messaging"],
  cron: ["0 1 * * *"], // 01:00 UTC = 09:00 MYT
  async run(ctx, input, config) {
    await ctx.db.migrate([
      `CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, amount REAL, detail TEXT, at INTEGER NOT NULL)`,
      `CREATE INDEX events_at ON events (at)`,
      `CREATE TABLE reports (run_id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, window_end INTEGER NOT NULL, total INTEGER NOT NULL, sent INTEGER NOT NULL)`,
    ]);

    if (input.event) {
      const { type, amount, detail } = input.event;
      await ctx.step.do("record-event", () =>
        ctx.db.sql`INSERT INTO events (type, amount, detail, at) VALUES (${type}, ${amount ?? null}, ${detail ?? null}, ${Date.now()})`,
      );
      return { recorded: type };
    }

    // Fix the window once, so a retried send reports exactly the same numbers.
    const end = await ctx.step.do("fix-window", () => Date.now());
    const start = end - 24 * HOUR_MS;

    const summary = await ctx.step.do("summarise-events", async () => {
      const byType = await ctx.db.query<TypeRow>(
        "SELECT type, COUNT(*) AS n, SUM(amount) AS total FROM events WHERE at >= ? AND at < ? GROUP BY type ORDER BY n DESC, type",
        [start, end],
      );
      const previous = await ctx.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE at >= ? AND at < ?", [
        start - 24 * HOUR_MS,
        start,
      ]);
      return { byType, total: byType.reduce((sum, r) => sum + r.n, 0), previousTotal: previous?.n ?? 0 };
    });

    const date = new Intl.DateTimeFormat("en-MY", { dateStyle: "full", timeZone: config.timeZone }).format(end);
    const change = summary.total - summary.previousTotal;
    const lines = summary.byType
      .slice(0, config.topTypes)
      .map((r) => `• ${r.type}: ${r.n}${r.total !== null ? ` (total ${r.total.toFixed(2)})` : ""}`);
    const others = summary.byType.length - lines.length;
    const text = [
      `📊 ${config.title}, ${date}`,
      `${summary.total} events in the last 24 hours (${change >= 0 ? "+" : ""}${change} vs the day before)`,
      ...lines,
      ...(others > 0 ? [`• and ${others} more types`] : []),
    ].join("\n");

    const send = summary.total > 0 || !config.skipEmpty;
    if (send) await ctx.step.do("send-report", () => ctx.messaging.send(config.reportTo, text, { subject: `${config.title}, ${date}` }));

    await ctx.step.do("log-report", () =>
      ctx.db.sql`INSERT INTO reports (run_id, window_start, window_end, total, sent) VALUES (${ctx.runId}, ${start}, ${end}, ${summary.total}, ${send ? 1 : 0})`,
    );
    return { total: summary.total, sent: send };
  },
});

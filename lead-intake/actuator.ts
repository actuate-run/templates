import { defineActuator, z, type MessagingProvider } from "@actuate/sdk";

export const ConfigSchema = z.object({
  businessName: z.string().default("Studio Gerak"),
  // Someone on your team who hears when a lead replies. Empty: nobody is pinged.
  notifyTo: z.string().default(""),
});

export const InputSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.email(),
  interest: z.string().max(1000).default("").describe("What the lead asked about, in their words"),
});

export const OutputSchema = z.object({
  leadId: z.string(),
  status: z.enum(["REPLIED", "COLD"]),
});

const sendEmail = (messaging: MessagingProvider, to: string, subject: string, html: string) =>
  messaging.send(to, html, { subject, format: "html" });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export default defineActuator({
  name: "lead_intake",
  description:
    "Hand over a sales lead. Saves it, sends a welcome email now and one follow-up after two days, and stops " +
    "the moment the lead replies. Call it once per lead with their name, a valid email and what they asked about. " +
    "It returns WAITING immediately; the final result is REPLIED or COLD after up to a week.",
  config: ConfigSchema,
  input: InputSchema,
  output: OutputSchema,
  capabilities: ["messaging"],
  async run(ctx, { name, email, interest }, config): Promise<z.output<typeof OutputSchema>> {
    const id = ctx.runId;
    await ctx.db.migrate([
      `CREATE TABLE leads (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, interest TEXT NOT NULL,
         status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    ]);
    // An inbound-email webhook posts reply.<id>, ending a wait.
    const wait = (step: string, timeout: "2 days" | "4 days") =>
      ctx.step.waitForEvent(step, { event: `reply.${id}`, timeout });

    await ctx.step.do("save", ({ now }) =>
      ctx.db.sql`INSERT INTO leads VALUES (${id}, ${name}, ${email}, ${interest}, 'NEW', ${now}, ${now})`,
    );
    await ctx.step.do("day-1", () =>
      sendEmail(
        ctx.messaging,
        email,
        `Thanks for your interest in ${config.businessName}`,
        `<p>Hi ${esc(name)}, thanks!</p>` +
          (interest ? `<p>You asked: <i>${esc(interest)}</i>. Just reply to this email and we'll help.</p>` : "") +
          `<p>${esc(config.businessName)}</p>`,
      ),
    );

    let reply = await wait("day-3", "2 days");
    if (!reply) {
      await ctx.step.do("follow-up", () =>
        sendEmail(ctx.messaging, email, `Any questions, ${name}?`, `<p>Hi ${esc(name)}, any questions? Reply here and a real person will answer.</p>`),
      );
      reply = await wait("day-7", "4 days");
    }

    const status = reply ? "REPLIED" : "COLD";
    await ctx.step.do("close", ({ now }) => ctx.db.sql`
      UPDATE leads SET status = ${status}, updated_at = ${now} WHERE id = ${id}`);
    if (status === "REPLIED" && config.notifyTo) {
      await ctx.step.do("notify-team", () => ctx.messaging.send(config.notifyTo, `${name} <${email}> replied. Lead ${id}.`));
    }
    return { leadId: id, status };
  },
});

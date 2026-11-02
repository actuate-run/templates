import { defineActuator, z } from "@actuate/sdk";

export const ConfigSchema = z.object({
  businessName: z.string().default("Klinik Pergigian Senyum"),
  depositAmount: z.number().min(1).max(10_000).default(50),
  currency: z.string().length(3).default("MYR"),
  reminderDelay: z.enum(["30 minutes", "2 hours", "24 hours"]).default("2 hours"),
  // After the reminder, how much longer the slot is held before it is released.
  holdAfterReminder: z.enum(["2 hours", "12 hours", "24 hours"]).default("24 hours"),
  timeZone: z.string().default("Asia/Kuala_Lumpur"),
});

export const InputSchema = z.object({
  customerName: z.string().min(1),
  contact: z.string().min(3).describe("Phone number (WhatsApp) or chat ID (Telegram) to message"),
  appointmentIso: z.iso.datetime({ offset: true }).describe("Appointment start, ISO 8601"),
});

const DAY_MS = 24 * 60 * 60 * 1000;

export default defineActuator({
  name: "deposit_reminder",
  description:
    "Books an appointment, sends the customer a deposit payment link, reminds them if they have not paid, " +
    "confirms the booking once paid, and sends an appointment reminder a day before.",
  config: ConfigSchema,
  input: InputSchema,
  capabilities: ["payment", "messaging"],
  async run(ctx, input, config) {
    await ctx.db.migrate([
      `CREATE TABLE bookings (
         id TEXT PRIMARY KEY, customer_name TEXT NOT NULL, contact TEXT NOT NULL,
         appointment_at TEXT NOT NULL, status TEXT NOT NULL, bill_id TEXT, updated_at TEXT NOT NULL)`,
    ]);
    const bookingId = ctx.runId;
    const deposit = `${config.currency} ${config.depositAmount.toFixed(2)}`;
    const when = new Intl.DateTimeFormat("en-MY", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: config.timeZone,
    }).format(new Date(input.appointmentIso));

    await ctx.step.do("save-booking", async () => {
      await ctx.db.sql`INSERT OR IGNORE INTO bookings (id, customer_name, contact, appointment_at, status, updated_at)
        VALUES (${bookingId}, ${input.customerName}, ${input.contact}, ${input.appointmentIso}, 'PENDING', ${new Date().toISOString()})`;
    });

    const payUrl = await ctx.step.do("send-payment-link", { retries: 3 }, async ({ idempotencyKey }) => {
      const bill = await ctx.payment.createBill({
        amount: config.depositAmount,
        currency: config.currency,
        referenceId: bookingId,
        description: `Deposit for ${config.businessName}, ${when}`,
        customer: { name: input.customerName },
        idempotencyKey,
      });
      await ctx.db.sql`UPDATE bookings SET bill_id = ${bill.id} WHERE id = ${bookingId}`;
      await ctx.messaging.send(
        input.contact,
        `Hi ${input.customerName}, your appointment at ${config.businessName} on ${when} is on hold. ` +
          `Please pay the ${deposit} deposit to confirm: ${bill.url}`,
      );
      return bill.url;
    });

    // The payment provider's webhook arrives as the event `payment.<referenceId>`.
    let paid = await ctx.step.waitForEvent("wait-for-deposit", {
      event: `payment.${bookingId}`,
      timeout: config.reminderDelay,
    });
    if (paid === null) {
      await ctx.step.do("send-payment-reminder", () =>
        ctx.messaging.send(input.contact, `Reminder: your ${deposit} deposit for ${when} is still pending. Pay here: ${payUrl}`),
      );
      paid = await ctx.step.waitForEvent("wait-for-deposit-after-reminder", {
        event: `payment.${bookingId}`,
        timeout: config.holdAfterReminder,
      });
    }

    if (paid === null) {
      await ctx.step.do("release-slot", async () => {
        await ctx.db.sql`UPDATE bookings SET status = 'EXPIRED', updated_at = ${new Date().toISOString()} WHERE id = ${bookingId}`;
        await ctx.messaging.send(input.contact, `We didn't receive your deposit, so your ${when} slot has been released. Reply to rebook.`);
      });
      return { status: "EXPIRED" as const, bookingId };
    }

    await ctx.step.do("confirm-booking", async () => {
      await ctx.db.sql`UPDATE bookings SET status = 'CONFIRMED', updated_at = ${new Date().toISOString()} WHERE id = ${bookingId}`;
      await ctx.messaging.send(input.contact, `Thank you! Your appointment at ${config.businessName} on ${when} is confirmed.`);
    });

    // Only schedule the day-before reminder if there is still a day to go.
    const appointmentAt = Date.parse(input.appointmentIso);
    const remindAt = appointmentAt - DAY_MS;
    const worthReminding = await ctx.step.do("check-reminder-time", () => remindAt > Date.now());
    if (!worthReminding) return { status: "CONFIRMED" as const, bookingId };

    await ctx.step.sleepUntil("until-day-before", remindAt);
    await ctx.step.do("send-appointment-reminder", () =>
      ctx.messaging.send(input.contact, `See you tomorrow, ${input.customerName}! ${config.businessName}, ${when}.`),
    );
    return { status: "REMINDED" as const, bookingId };
  },
});

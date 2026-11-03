import { describe, expect, it } from "vitest";
import { testActuator } from "@actuate/cli/testing";
import actuator from "../deposit-reminder/actuator.js";

const NOW = Date.parse("2026-11-02T00:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const input = { customerName: "Aina", contact: "+60123456789", appointmentIso: new Date(NOW + 3 * DAY).toISOString() };
const setup = (config: Record<string, unknown> = {}, plan?: "maker") => testActuator(actuator, { config, now: NOW, ...(plan ? { plan } : {}) });

describe("deposit-reminder", () => {
  it("sends a payment link, confirms on payment, and reminds the day before", async () => {
    const t = setup({ depositAmount: 80 });
    const run = await t.start(input);
    expect(run.status).toBe("WAITING");
    expect(t.bills).toEqual([expect.objectContaining({ amount: 80, currency: "MYR", referenceId: run.runId, idempotencyKey: `${run.runId}:send-payment-link:createBill:0` })]);
    expect(t.messages[0]!.text).toContain(`MYR 80.00 deposit to confirm: https://pay.test/${run.runId}`);
    expect(t.rows("bookings")[0]).toMatchObject({ status: "PENDING", bill_id: "bill-1" });

    await t.pay(run.runId);
    expect(t.rows("bookings")[0]).toMatchObject({ status: "CONFIRMED" });
    expect(t.messages[1]!.text).toMatch(/is confirmed/);
    expect(t.run(run.runId).status).toBe("WAITING"); // sleeping until the day before

    await t.advance(2 * DAY - HOUR);
    expect(t.messages).toHaveLength(2);
    await t.advance("1 hour");
    expect(t.messages[2]!.text).toMatch(/^See you tomorrow, Aina!/);
    expect(t.run(run.runId)).toMatchObject({ status: "COMPLETED", output: { status: "REMINDED" } });
  });

  it("reminds after the delay, then confirms a late payment", async () => {
    const t = setup({ reminderDelay: "30 minutes" });
    const run = await t.start(input);
    await t.advance("30 minutes");
    expect(t.messages[1]!.text).toMatch(/^Reminder: your MYR 50.00 deposit/);
    await t.pay(run.runId);
    expect(t.rows("bookings")[0]).toMatchObject({ status: "CONFIRMED" });
  });

  it("releases the slot when the deposit never arrives", async () => {
    const t = setup();
    const run = await t.start(input);
    await t.advance("26 hours"); // the reminder after 2 hours, the release 24 hours later
    expect(t.run(run.runId)).toMatchObject({ status: "COMPLETED", output: { status: "EXPIRED" } });
    expect(t.rows("bookings")[0]).toMatchObject({ status: "EXPIRED" });
    expect(t.messages.map((m) => m.text)).toEqual([
      expect.stringContaining("deposit to confirm"),
      expect.stringContaining("Reminder"),
      expect.stringContaining("has been released"),
    ]);
  });

  it("skips the day-before reminder when the appointment is less than a day away", async () => {
    const t = setup();
    const run = await t.start({ ...input, appointmentIso: new Date(NOW + 6 * HOUR).toISOString() });
    await t.pay(run.runId);
    expect(t.run(run.runId)).toMatchObject({ status: "COMPLETED", output: { status: "CONFIRMED" } });
    expect(t.messages).toHaveLength(2);
  });

  it("sleeps for weeks on Maker, until the day before the appointment", async () => {
    const t = setup({}, "maker");
    const run = await t.start({ ...input, appointmentIso: new Date(NOW + 15 * DAY).toISOString() });
    await t.pay(run.runId);
    await t.advance("13 days");
    expect(t.messages).toHaveLength(2);
    await t.advance("1 day");
    expect(t.run(run.runId)).toMatchObject({ status: "COMPLETED", output: { status: "REMINDED" } });
  });

  it("retries the payment link step with the same idempotency key for the bill", async () => {
    let sends = 0;
    const t = testActuator(actuator, {
      now: NOW,
      providers: {
        messaging: {
          async send() {
            if (++sends === 1) throw new Error("WhatsApp is down");
            return { id: `msg-${sends}`, channel: "test" };
          },
        },
      },
    });
    const run = await t.start(input);
    await t.advance("1 second");
    expect(t.run(run.runId).status).toBe("WAITING"); // now waiting for the deposit
    // Both attempts asked for the same bill with the same key, so the provider (here the fake, as Stripe does) created it once.
    expect(t.bills.map((b) => b.idempotencyKey)).toEqual([`${run.runId}:send-payment-link:createBill:0`]);
    expect(sends).toBe(2);
  });

  it("rejects a malformed appointment time before running", async () => {
    await expect(setup().start({ ...input, appointmentIso: "tomorrow" })).rejects.toThrow(/appointmentIso/);
  });

  it("treats a failed payment as unpaid and reminds", async () => {
    const t = setup();
    const run = await t.start(input);
    await t.pay(run.runId, { status: "failed" });
    expect(t.messages.some((m) => m.text.startsWith("Reminder:"))).toBe(true);
    expect(t.run(run.runId).status).toBe("WAITING");
  });
});

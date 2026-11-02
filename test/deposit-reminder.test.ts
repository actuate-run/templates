import { describe, expect, it } from "vitest";
import actuator from "../deposit-reminder/actuator.js";
import { DAY, HOUR, T0, fakeProviders, harness } from "./harness.js";

const appointmentIso = new Date(T0 + 3 * DAY).toISOString();
const input = { customerName: "Aina", contact: "+60123456789", appointmentIso };

function setup(config: Record<string, unknown> = {}) {
  const fakes = fakeProviders();
  return { ...fakes, h: harness(actuator, { providers: fakes.providers, config }) };
}

describe("deposit-reminder", () => {
  it("sends a payment link, confirms on payment, and reminds the day before", async () => {
    const { h, sent, bills } = setup({ depositAmount: 80 });
    const run = await h.start(input);
    expect(run.status).toBe("WAITING");
    expect(bills).toEqual([expect.objectContaining({ amount: 80, currency: "MYR", referenceId: run.runId })]);
    expect(sent[0]!.text).toContain(`MYR 80.00 deposit to confirm: https://pay.test/${run.runId}`);
    expect(h.rows("bookings")[0]).toMatchObject({ status: "PENDING", bill_id: "bill-1" });

    await h.manager.deliverEvent(`payment.${run.runId}`, { status: "paid" });
    expect(h.rows("bookings")[0]).toMatchObject({ status: "CONFIRMED" });
    expect(sent[1]!.text).toMatch(/is confirmed/);
    expect(h.run(run.runId).status).toBe("WAITING"); // sleeping until the day before

    await h.advance(2 * DAY - HOUR);
    expect(sent).toHaveLength(2);
    await h.advance(HOUR);
    expect(sent[2]!.text).toMatch(/^See you tomorrow, Aina!/);
    expect(h.run(run.runId)).toMatchObject({ status: "COMPLETED", output: { status: "REMINDED" } });
  });

  it("reminds after the delay, then confirms a late payment", async () => {
    const { h, sent } = setup({ reminderDelay: "30 minutes" });
    const run = await h.start(input);
    await h.advance(30 * 60_000);
    expect(sent[1]!.text).toMatch(/^Reminder: your MYR 50.00 deposit/);
    await h.manager.deliverEvent(`payment.${run.runId}`, { provider: "test", status: "paid", referenceId: run.runId });
    expect(h.rows("bookings")[0]).toMatchObject({ status: "CONFIRMED" });
  });

  it("releases the slot when the deposit never arrives", async () => {
    const { h, sent } = setup();
    const run = await h.start(input);
    await h.advance(2 * HOUR);
    await h.advance(24 * HOUR);
    expect(h.run(run.runId)).toMatchObject({ status: "COMPLETED", output: { status: "EXPIRED" } });
    expect(h.rows("bookings")[0]).toMatchObject({ status: "EXPIRED" });
    expect(sent.map((m) => m.text)).toEqual([
      expect.stringContaining("deposit to confirm"),
      expect.stringContaining("Reminder"),
      expect.stringContaining("has been released"),
    ]);
  });

  it("skips the day-before reminder when the appointment is less than a day away", async () => {
    const { h, sent } = setup();
    const run = await h.start({ ...input, appointmentIso: new Date(T0 + 6 * HOUR).toISOString() });
    await h.manager.deliverEvent(`payment.${run.runId}`, { provider: "test", status: "paid", referenceId: run.runId });
    expect(h.run(run.runId)).toMatchObject({ status: "COMPLETED", output: { status: "CONFIRMED" } });
    expect(sent).toHaveLength(2);
  });

  it("rejects a malformed appointment time before running", async () => {
    const { h } = setup();
    await expect(h.start({ ...input, appointmentIso: "tomorrow" })).rejects.toThrow();
  });

  it("treats a failed payment as unpaid and reminds", async () => {
    const { h, sent } = setup();
    const run = await h.start(input);
    await h.manager.deliverEvent(`payment.${run.runId}`, { provider: "test", status: "failed", referenceId: run.runId });
    expect(sent.some((m) => m.text.startsWith("Reminder:"))).toBe(true);
    expect(h.manager.getRun(run.runId)!.status).toBe("WAITING");
  });
});

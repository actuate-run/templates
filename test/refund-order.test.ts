import { describe, expect, it } from "vitest";
import { testActuator } from "@actuate/cli/testing";
import type { PaymentProvider } from "@actuate/sdk";
import actuator from "../refund-order/actuator.js";

const call = { orderId: "2291", billId: "bill-9", amount: 120, reason: "Arrived broken" };
const setup = (payment?: PaymentProvider) => testActuator(actuator, payment ? { providers: { payment } } : {});
const noBills = { createBill: async () => Promise.reject(new Error("not used")), getBill: async () => Promise.reject(new Error("not used")) };

describe("refund-order", () => {
  it("refunds at or below the threshold without asking, with an idempotency key from the step", async () => {
    const t = setup();
    const run = await t.start({ ...call, amount: 50 });
    expect(run.output).toEqual({ status: "REFUNDED", orderId: "2291", amount: 50, refundId: "refund-1" });
    expect(t.refunds).toEqual([{ billId: "bill-9", amount: 50, reason: "Arrived broken", idempotencyKey: `${run.runId}:refund:refund:0` }]);
    expect(t.approvals).toHaveLength(0);
    expect(t.rows("refunds")).toEqual([expect.objectContaining({ order_id: "2291", amount: 50, status: "REFUNDED", refund_id: "refund-1" })]);
  });

  it("waits for the manager above the threshold and refunds on approve", async () => {
    const t = setup();
    const run = await t.start(call);
    expect(run.status).toBe("WAITING");
    expect(t.approvals[0]).toMatchObject({ step: "manager", notify: "@shop_manager", message: "Refund MYR 120.00, order 2291?\nReason: Arrived broken" });
    expect(t.refunds).toHaveLength(0);
    await t.approve("manager", { note: "OK, sorry Aina" });
    expect(t.run(run.runId).output).toEqual({ status: "REFUNDED", orderId: "2291", amount: 120, refundId: "refund-1", note: "OK, sorry Aina" });
    expect(t.rows("refunds")).toEqual([expect.objectContaining({ status: "REFUNDED", note: "OK, sorry Aina" })]);
  });

  it("declines on reject or timeout, moves no money, and audits the decision", async () => {
    const rejected = setup();
    const run = await rejected.start(call);
    await rejected.reject("manager", { note: "Ask for a photo first" });
    expect(rejected.run(run.runId).output).toEqual({ status: "DECLINED", orderId: "2291", note: "Ask for a photo first" });
    expect(rejected.rows("refunds")).toEqual([expect.objectContaining({ status: "DECLINED", note: "Ask for a photo first" })]);

    const ignored = setup();
    const run2 = await ignored.start(call);
    await ignored.advance("24 hours");
    expect(ignored.run(run2.runId).output).toMatchObject({ status: "DECLINED", note: expect.stringMatching(/expired/) });
    expect(ignored.rows("refunds")).toEqual([expect.objectContaining({ status: "DECLINED" })]);
    expect([...rejected.refunds, ...ignored.refunds]).toHaveLength(0);
  });

  it("caps the amount in code, whatever the agent asks for", async () => {
    const t = setup();
    const run = await t.start({ ...call, amount: 99_999 });
    expect(t.approvals[0]!.message).toContain("Refund MYR 500.00");
    await t.approve();
    expect(t.run(run.runId).output).toMatchObject({ amount: 500 });
    expect(t.refunds[0]!.amount).toBe(500);
  });

  it("refuses a second refund for the same order", async () => {
    const t = setup();
    await t.start({ ...call, amount: 30 });
    expect((await t.start({ ...call, amount: 40 })).output).toEqual({ status: "ALREADY_REFUNDED", orderId: "2291", amount: 30 });
    expect(t.refunds).toHaveLength(1);
  });

  it("retries a failed refund with the same key, and writes one audit row only once it succeeds", async () => {
    const keys: Array<string | undefined> = [];
    const t = setup({
      ...noBills,
      async refund(request) {
        keys.push(request.idempotencyKey);
        return { id: `re_${keys.length}`, status: keys.length < 3 ? "failed" : "succeeded" };
      },
    });
    const run = await t.start({ ...call, amount: 20 });
    expect(t.run(run.runId).status).toBe("WAITING"); // backing off before the retry
    expect(t.rows("refunds")).toEqual([]);
    await t.advance("10 seconds"); // 1 s, then 2 s of backoff
    expect(t.run(run.runId).output).toEqual({ status: "REFUNDED", orderId: "2291", amount: 20, refundId: "re_3" });
    expect(new Set(keys)).toEqual(new Set([`${run.runId}:refund:refund:0`]));
    expect(t.rows("refunds")).toEqual([expect.objectContaining({ status: "REFUNDED", refund_id: "re_3" })]);
  });

  it("records nothing when every attempt fails, so a later call can still refund", async () => {
    const t = setup({ ...noBills, refund: async () => ({ id: "re_x", status: "failed" }) });
    const run = await t.start({ ...call, amount: 20 });
    await t.advance("1 minute");
    expect(t.run(run.runId)).toMatchObject({ status: "FAILED", error: { message: "Refund re_x failed at the payment provider." } });
    expect(t.steps(run.runId).find((s) => s.name === "refund")).toMatchObject({ status: "FAILED", attempts: 4 });
    expect(t.rows("refunds")).toEqual([]);
  });

  it("fails loudly when the payment provider cannot refund", async () => {
    const t = setup(noBills);
    const run = await t.start({ ...call, amount: 10 });
    expect(run).toMatchObject({ status: "FAILED", error: { message: expect.stringMatching(/cannot issue refunds/) } });
  });
});

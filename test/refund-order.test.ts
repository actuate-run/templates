import { describe, expect, it } from "vitest";
import actuator from "../refund-order/actuator.js";
import { DAY, fakeProviders, harness } from "./harness.js";

const call = { orderId: "2291", billId: "bill-9", amount: 120, reason: "Arrived broken" };

function setup(opts: { refund?: boolean } = {}) {
  const fakes = fakeProviders(opts);
  return { ...fakes, h: harness(actuator, { providers: fakes.providers }) };
}

describe("refund-order", () => {
  it("refunds at or below the threshold without asking, with the step's idempotency key", async () => {
    const { h, refunds } = setup();
    const run = await h.start({ ...call, amount: 50 });
    expect(run.output).toEqual({ status: "REFUNDED", orderId: "2291", amount: 50, refundId: "refund-1" });
    expect(refunds).toEqual([{ billId: "bill-9", amount: 50, reason: "Arrived broken", idempotencyKey: `${run.runId}:refund` }]);
    expect(h.approvals).toHaveLength(0);
    expect(h.rows("refunds")).toEqual([expect.objectContaining({ order_id: "2291", amount: 50, status: "REFUNDED", refund_id: "refund-1" })]);
  });

  it("waits for the manager above the threshold and refunds on approve", async () => {
    const { h, refunds } = setup();
    const run = await h.start(call);
    expect(run.status).toBe("WAITING");
    expect(h.approvals[0]).toMatchObject({ step: "manager", notify: "@shop_manager", message: "Refund MYR 120.00, order 2291?\nReason: Arrived broken" });
    expect(refunds).toHaveLength(0);
    await h.decide(true);
    expect(h.run(run.runId).output).toEqual({ status: "REFUNDED", orderId: "2291", amount: 120, refundId: "refund-1" });
  });

  it("declines on reject or timeout, moves no money, and audits the decision", async () => {
    const rejected = setup();
    const run = await rejected.h.start(call);
    await rejected.h.manager.decideDirect(run.runId, "manager", false, "Ask for a photo first");
    expect(rejected.h.run(run.runId).output).toEqual({ status: "DECLINED", orderId: "2291", note: "Ask for a photo first" });

    const ignored = setup();
    const run2 = await ignored.h.start(call);
    await ignored.h.advance(DAY);
    expect(ignored.h.run(run2.runId).output).toMatchObject({ status: "DECLINED", note: expect.stringMatching(/expired/) });
    expect(ignored.h.rows("refunds")).toEqual([expect.objectContaining({ status: "DECLINED" })]);
    expect([...rejected.refunds, ...ignored.refunds]).toHaveLength(0);
  });

  it("caps the amount in code, whatever the agent asks for", async () => {
    const { h, refunds } = setup();
    const run = await h.start({ ...call, amount: 99_999 });
    expect(h.approvals[0]!.message).toContain("Refund MYR 500.00");
    await h.decide(true);
    expect(h.run(run.runId).output).toMatchObject({ amount: 500 });
    expect(refunds[0]!.amount).toBe(500);
  });

  it("refuses a second refund for the same order", async () => {
    const { h, refunds } = setup();
    await h.start({ ...call, amount: 30 });
    expect((await h.start({ ...call, amount: 40 })).output).toEqual({ status: "ALREADY_REFUNDED", orderId: "2291", amount: 30 });
    expect(refunds).toHaveLength(1);
  });

  it("fails loudly when the payment provider cannot refund", async () => {
    const { h } = setup({ refund: false });
    const run = await h.start({ ...call, amount: 10 });
    expect(run).toMatchObject({ status: "FAILED", error: { message: expect.stringMatching(/cannot issue refunds/) } });
  });
});

import { describe, expect, it } from "vitest";
import { testActuator } from "@actuate/cli/testing";
import type { PaymentProvider } from "@actuate/sdk";
import actuator from "../support-escalation/actuator.js";

const config = { approver: "manager-chat", supportTeam: "team-chat", approvalThreshold: 50, maxRefund: 200 };
const ticket = {
  ticketId: "T-1",
  customerName: "Aina",
  contact: "aina-chat",
  message: "My order arrived broken, please refund",
  billId: "bill-9",
  orderAmount: 120,
};
const triage = (intent: string, refundAmount: number | null = null, reply = "ok") =>
  JSON.stringify({ intent, refundAmount, reply });
const setup = (llmReply: string, payment?: PaymentProvider) =>
  testActuator(actuator, { config, llm: [llmReply], ...(payment ? { providers: { payment } } : {}) });
const decisions = (t: ReturnType<typeof setup>) => t.rows("decisions").map((r) => r.decision);

describe("support-escalation", () => {
  it("answers a simple question with the model's reply", async () => {
    const t = setup(`Sure: ${triage("question", null, "We open at 9am.")}`);
    const run = await t.start({ ...ticket, message: "When do you open?" });
    expect(run.output).toEqual({ outcome: "ANSWERED" });
    expect(t.messages).toMatchObject([{ to: "aina-chat", text: "We open at 9am." }]);
    expect(decisions(t)).toEqual(["classified:question"]);
    expect(t.prompts[0]).toMatchObject({ prompt: expect.stringContaining("Customer message:\nWhen do you open?"), maxTokens: 400 });
  });

  it("refunds small amounts without asking anyone", async () => {
    const t = setup(triage("refund", 30));
    const run = await t.start(ticket);
    expect(run.output).toEqual({ outcome: "REFUNDED", amount: 30, refundStatus: "succeeded" });
    expect(t.refunds).toEqual([{ billId: "bill-9", amount: 30, reason: "Ticket T-1", idempotencyKey: `${run.runId}:issue-refund:refund:0` }]);
    expect(t.approvals).toHaveLength(0);
    expect(decisions(t)).toEqual(["classified:refund", "refund:succeeded"]);
  });

  it("waits for approval above the threshold and refunds when approved", async () => {
    const t = setup(triage("refund", 100));
    const run = await t.start(ticket);
    expect(run.status).toBe("WAITING");
    expect(t.approvals[0]).toMatchObject({ notify: "manager-chat", message: expect.stringContaining("Refund MYR 100.00") });
    expect(t.refunds).toHaveLength(0);

    await t.approve("manager-approval");
    expect(t.run(run.runId).output).toMatchObject({ outcome: "REFUNDED", amount: 100 });
    expect(t.refunds).toHaveLength(1);
    expect(t.messages.at(-1)!.text).toMatch(/refunded MYR 100.00/);
    expect(decisions(t)).toEqual(["classified:refund", "approved", "refund:succeeded"]);
  });

  it("does not refund when the approver rejects or never answers", async () => {
    const rejected = setup(triage("refund", 100));
    const run = await rejected.start(ticket);
    await rejected.reject("manager-approval", { note: "Photo first" });
    expect(rejected.run(run.runId).output).toEqual({ outcome: "REFUND_DECLINED", amount: 100 });
    expect(rejected.rows("decisions")).toContainEqual(expect.objectContaining({ decision: "rejected", detail: "Photo first" }));
    expect(rejected.refunds).toHaveLength(0);

    const ignored = setup(triage("refund", 100));
    const run2 = await ignored.start(ticket);
    await ignored.advance("24 hours");
    expect(ignored.run(run2.runId).output).toEqual({ outcome: "REFUND_DECLINED", amount: 100 });
    expect(decisions(ignored)).toContain("approval-timed-out");
    expect(ignored.refunds).toHaveLength(0);
  });

  it("caps the refund in code, whatever the model asks for", async () => {
    const t = setup(triage("refund", 100_000));
    const run = await t.start({ ...ticket, orderAmount: 1_000 });
    expect(t.approvals[0]!.message).toContain("Refund MYR 200.00");
    await t.approve();
    expect(t.run(run.runId).output).toMatchObject({ amount: 200 });
    expect(t.refunds[0]!.amount).toBe(200);
  });

  it("escalates complaints and unparseable model output to the team", async () => {
    for (const reply of [triage("complaint"), "I am not JSON"]) {
      const t = setup(reply);
      const run = await t.start(ticket);
      expect(run.output).toEqual({ outcome: "ESCALATED" });
      expect(t.messages.map((m) => m.to)).toEqual(["team-chat", "aina-chat"]);
    }
  });

  it("retries the model call, then triages with its answer", async () => {
    let calls = 0;
    const t = testActuator(actuator, {
      config,
      llm: () => {
        if (++calls === 1) throw new Error("overloaded");
        return triage("question", null, "Yes, we deliver.");
      },
    });
    const run = await t.start({ ...ticket, message: "Do you deliver?" });
    await t.advance("1 second");
    expect(t.run(run.runId).output).toEqual({ outcome: "ANSWERED" });
    expect(calls).toBe(2);
  });

  it("falls back to a manual refund when the payment provider cannot refund", async () => {
    const t = setup(triage("refund", 20), { createBill: () => Promise.reject(new Error("not used")), getBill: () => Promise.reject(new Error("not used")) });
    const run = await t.start(ticket);
    expect(run.output).toMatchObject({ outcome: "REFUNDED", refundStatus: "manual" });
    expect(t.messages.at(-1)!.text).toMatch(/processed by our team/);
  });
});

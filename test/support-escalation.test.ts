import { describe, expect, it } from "vitest";
import actuator from "../support-escalation/actuator.js";
import { DAY, fakeProviders, harness } from "./harness.js";

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

function setup(llmReply: string, opts: { refund?: boolean } = {}) {
  const fakes = fakeProviders({ llmReplies: [llmReply], ...opts });
  return { ...fakes, h: harness(actuator, { providers: fakes.providers, config }) };
}

describe("support-escalation", () => {
  it("answers a simple question with the model's reply", async () => {
    const { h, sent } = setup(`Sure: ${triage("question", null, "We open at 9am.")}`);
    const run = await h.start({ ...ticket, message: "When do you open?" });
    expect(run.output).toEqual({ outcome: "ANSWERED" });
    expect(sent).toEqual([{ to: "aina-chat", text: "We open at 9am." }]);
    expect(h.rows("decisions").map((r) => r.decision)).toEqual(["classified:question"]);
  });

  it("refunds small amounts without asking anyone", async () => {
    const { h, refunds } = setup(triage("refund", 30));
    const run = await h.start(ticket);
    expect(run.output).toEqual({ outcome: "REFUNDED", amount: 30, refundStatus: "succeeded" });
    expect(refunds).toEqual([expect.objectContaining({ billId: "bill-9", amount: 30 })]);
    expect(h.approvals).toHaveLength(0);
    expect(h.rows("decisions").map((r) => r.decision)).toEqual(["classified:refund", "refund:succeeded"]);
  });

  it("waits for approval above the threshold and refunds when approved", async () => {
    const { h, refunds, sent } = setup(triage("refund", 100));
    const run = await h.start(ticket);
    expect(run.status).toBe("WAITING");
    expect(h.approvals[0]).toMatchObject({ notify: "manager-chat", message: expect.stringContaining("Refund MYR 100.00") });
    expect(refunds).toHaveLength(0);

    await h.decide(true);
    expect(h.run(run.runId).output).toMatchObject({ outcome: "REFUNDED", amount: 100 });
    expect(refunds).toHaveLength(1);
    expect(sent.at(-1)!.text).toMatch(/refunded MYR 100.00/);
    expect(h.rows("decisions").map((r) => r.decision)).toEqual(["classified:refund", "approved", "refund:succeeded"]);
  });

  it("does not refund when the approver rejects or never answers", async () => {
    const rejected = setup(triage("refund", 100));
    const run = await rejected.h.start(ticket);
    await rejected.h.decide(false);
    expect(rejected.h.run(run.runId).output).toEqual({ outcome: "REFUND_DECLINED", amount: 100 });
    expect(rejected.refunds).toHaveLength(0);

    const ignored = setup(triage("refund", 100));
    const run2 = await ignored.h.start(ticket);
    await ignored.h.advance(DAY);
    expect(ignored.h.run(run2.runId).output).toEqual({ outcome: "REFUND_DECLINED", amount: 100 });
    expect(ignored.h.rows("decisions").map((r) => r.decision)).toContain("approval-timed-out");
    expect(ignored.refunds).toHaveLength(0);
  });

  it("caps the refund in code, whatever the model asks for", async () => {
    const { h, refunds } = setup(triage("refund", 100_000));
    const run = await h.start({ ...ticket, orderAmount: 1_000 });
    expect(h.approvals[0]!.message).toContain("Refund MYR 200.00");
    await h.decide(true);
    expect(h.run(run.runId).output).toMatchObject({ amount: 200 });
    expect(refunds[0]!.amount).toBe(200);
  });

  it("escalates complaints and unparseable model output to the team", async () => {
    for (const reply of [triage("complaint"), "I am not JSON"]) {
      const { h, sent } = setup(reply);
      const run = await h.start(ticket);
      expect(run.output).toEqual({ outcome: "ESCALATED" });
      expect(sent.map((m) => m.to)).toEqual(["team-chat", "aina-chat"]);
    }
  });

  it("falls back to a manual refund when the payment provider cannot refund", async () => {
    const { h, sent } = setup(triage("refund", 20), { refund: false });
    const run = await h.start(ticket);
    expect(run.output).toMatchObject({ outcome: "REFUNDED", refundStatus: "manual" });
    expect(sent.at(-1)!.text).toMatch(/processed by our team/);
  });
});

import { describe, expect, it } from "vitest";
import actuator from "../approve-message/actuator.js";
import { HOUR, fakeProviders, harness } from "./harness.js";

const call = { to: "aina@example.com", draft: "Sorry about the delay. Here is 20% off your next order.", context: "Late delivery, order 2291", subject: "About your order" };

function setup() {
  const fakes = fakeProviders();
  return { ...fakes, h: harness(actuator, { providers: fakes.providers, config: { approver: "lead-chat" } }) };
}

describe("approve-message", () => {
  it("sends nothing until a person approves, then sends the draft", async () => {
    const { h, sent } = setup();
    const run = await h.start(call);
    expect(run.status).toBe("WAITING");
    expect(sent).toHaveLength(0);
    expect(h.approvals[0]).toMatchObject({ notify: "lead-chat", message: expect.stringContaining(call.draft) });
    await h.decide(true);
    expect(sent).toEqual([{ to: call.to, text: call.draft, options: { subject: "About your order" } }]);
    expect(h.run(run.runId).output).toEqual({ status: "SENT", messageId: run.runId, sentText: call.draft, edited: false });
    expect(h.rows("outgoing_messages")[0]).toMatchObject({ status: "SENT", sent_text: call.draft });
  });

  it("sends the reviewer's edit when they approve with a note", async () => {
    const { h, sent } = setup();
    const run = await h.start(call);
    await h.manager.decideDirect(run.runId, "human-review", true, "Sorry about the delay. Here is 10% off your next order.");
    expect(sent[0]!.text).toBe("Sorry about the delay. Here is 10% off your next order.");
    expect(h.run(run.runId).output).toMatchObject({ status: "SENT", edited: true });
  });

  it("never sends a rejected or expired message", async () => {
    const rejected = setup();
    const run = await rejected.h.start(call);
    await rejected.h.manager.decideDirect(run.runId, "human-review", false, "We don't discount for this");
    expect(rejected.h.run(run.runId).output).toEqual({ status: "REJECTED", messageId: run.runId, edited: false, reviewerNote: "We don't discount for this" });

    const expired = setup();
    const run2 = await expired.h.start(call);
    await expired.h.advance(4 * HOUR);
    expect(expired.h.run(run2.runId).output).toEqual({ status: "EXPIRED", messageId: run2.runId, edited: false });
    expect(expired.h.rows("outgoing_messages")[0]).toMatchObject({ status: "EXPIRED", sent_text: null });
    expect([...rejected.sent, ...expired.sent]).toHaveLength(0);
  });
});

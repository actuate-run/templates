import { describe, expect, it } from "vitest";
import { testActuator } from "@actuate/cli/testing";
import actuator from "../escalate-to-human/actuator.js";

const call = { question: "Can Aina change her delivery address after dispatch?", customerName: "Aina", urgency: "urgent" };
const setup = () => testActuator(actuator, { config: { humanContact: "support-chat" }, now: "2026-11-02T00:00:00Z" });

describe("escalate-to-human", () => {
  it("opens a ticket, sends a person an answer link, and returns their answer", async () => {
    const t = setup();
    const run = await t.start(call);
    expect(run.status).toBe("WAITING");
    expect(t.approvals[0]).toMatchObject({
      kind: "input",
      step: "human-answer",
      notify: "support-chat",
      message: expect.stringMatching(/^🚨 URGENT: .*for Aina\.\n\nQuestion: Can Aina change/),
      answerUrl: expect.any(String),
    });
    expect(t.rows("tickets")[0]).toMatchObject({ id: run.runId, status: "OPEN", urgency: "urgent" });

    await t.advance("1 hour");
    await t.answer("  Yes, until 5pm today. ", { by: "Siti" });
    expect(t.run(run.runId).output).toEqual({
      status: "ANSWERED",
      ticketId: run.runId,
      answer: "Yes, until 5pm today.",
      answeredAt: "2026-11-02T01:00:00.000Z",
      answeredBy: "Siti",
    });
    expect(t.rows("tickets")[0]).toMatchObject({ status: "ANSWERED", answer: "Yes, until 5pm today." });
  });

  it("returns TIMED_OUT when nobody answers in time, and the link stops working", async () => {
    const t = setup();
    const run = await t.start({ question: "Is the Bangsar branch open on Deepavali?" });
    await t.advance("4 hours");
    expect(t.run(run.runId).output).toEqual({ status: "TIMED_OUT", ticketId: run.runId });
    expect(t.rows("tickets")[0]).toMatchObject({ status: "TIMED_OUT", answer: null });
    // The link the person was sent, opened too late.
    const token = new URL(t.approvals[0]!.answerUrl!).searchParams.get("token")!;
    expect(await t.manager.decide(token, { text: "Too late" })).toMatchObject({ ok: false });
    await expect(t.answer("Too late")).rejects.toThrow(/No question \(waitForInput\) is waiting/);
  });

  it("never relays an empty answer: the form refuses it and the ticket stays open", async () => {
    const t = setup();
    const run = await t.start(call);
    await expect(t.answer("   ")).rejects.toThrow();
    expect(t.run(run.runId).status).toBe("WAITING");
    await t.answer("Yes.");
    expect(t.run(run.runId).output).toMatchObject({ status: "ANSWERED", answer: "Yes." });
  });
});

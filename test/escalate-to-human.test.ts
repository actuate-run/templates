import { describe, expect, it } from "vitest";
import actuator from "../escalate-to-human/actuator.js";
import { HOUR, T0, fakeProviders, harness } from "./harness.js";

const call = { question: "Can Aina change her delivery address after dispatch?", customerName: "Aina", urgency: "urgent" };

function setup() {
  const fakes = fakeProviders();
  return { ...fakes, h: harness(actuator, { providers: fakes.providers, config: { humanContact: "support-chat" } }) };
}

describe("escalate-to-human", () => {
  it("opens a ticket, sends a person an answer link, and returns their answer", async () => {
    const { h } = setup();
    const run = await h.start(call);
    expect(run.status).toBe("WAITING");
    expect(h.approvals[0]).toMatchObject({
      kind: "input",
      step: "human-answer",
      notify: "support-chat",
      message: expect.stringMatching(/^🚨 URGENT: .*for Aina\.\n\nQuestion: Can Aina change/),
      answerUrl: expect.any(String),
    });
    expect(h.rows("tickets")[0]).toMatchObject({ id: run.runId, status: "OPEN", urgency: "urgent" });

    await h.advance(HOUR);
    expect(await h.answer("  Yes, until 5pm today. ")).toMatchObject({ ok: true });
    expect(h.run(run.runId).output).toEqual({
      status: "ANSWERED",
      ticketId: run.runId,
      answer: "Yes, until 5pm today.",
      answeredAt: new Date(T0 + HOUR).toISOString(),
    });
    expect(h.rows("tickets")[0]).toMatchObject({ status: "ANSWERED", answer: "Yes, until 5pm today." });
  });

  it("returns TIMED_OUT when nobody answers in time, and the link stops working", async () => {
    const { h } = setup();
    const run = await h.start({ question: "Is the Bangsar branch open on Deepavali?" });
    await h.advance(4 * HOUR);
    expect(h.run(run.runId).output).toEqual({ status: "TIMED_OUT", ticketId: run.runId });
    expect(h.rows("tickets")[0]).toMatchObject({ status: "TIMED_OUT", answer: null });
    expect(await h.answer("Too late")).toMatchObject({ ok: false });
  });

  it("never relays an empty answer: the form refuses it and the ticket stays open", async () => {
    const { h } = setup();
    const run = await h.start(call);
    expect(await h.answer("   ")).toMatchObject({ ok: false });
    expect(h.run(run.runId).status).toBe("WAITING");
    await h.answer("Yes.");
    expect(h.run(run.runId).output).toMatchObject({ status: "ANSWERED", answer: "Yes." });
  });
});

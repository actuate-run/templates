import { describe, expect, it } from "vitest";
import actuator from "../escalate-to-human/actuator.js";
import { HOUR, fakeProviders, harness } from "./harness.js";

const call = { question: "Can Aina change her delivery address after dispatch?", customerName: "Aina", urgency: "urgent" };

function setup() {
  const fakes = fakeProviders();
  return { ...fakes, h: harness(actuator, { providers: fakes.providers, config: { humanContact: "support-chat" } }) };
}

describe("escalate-to-human", () => {
  it("opens a ticket, notifies a person, and returns their answer", async () => {
    const { h, sent } = setup();
    const run = await h.start(call);
    expect(run.status).toBe("WAITING");
    expect(sent[0]).toMatchObject({ to: "support-chat", text: expect.stringMatching(/^🚨 URGENT: .*for Aina/) });
    expect(sent[0]!.text).toContain(`answer.${run.runId}`);
    expect(h.rows("tickets")[0]).toMatchObject({ id: run.runId, status: "OPEN", urgency: "urgent" });

    await h.manager.deliverEvent(`answer.${run.runId}`, { answer: "Yes, until 5pm today.", by: "Farid" });
    expect(h.run(run.runId).output).toEqual({ status: "ANSWERED", ticketId: run.runId, answer: "Yes, until 5pm today.", answeredBy: "Farid" });
    expect(h.rows("tickets")[0]).toMatchObject({ status: "ANSWERED", answer: "Yes, until 5pm today." });
  });

  it("returns TIMED_OUT when nobody answers in time", async () => {
    const { h } = setup();
    const run = await h.start({ question: "Is the Bangsar branch open on Deepavali?" });
    await h.advance(4 * HOUR);
    expect(h.run(run.runId).output).toEqual({ status: "TIMED_OUT", ticketId: run.runId });
    expect(h.rows("tickets")[0]).toMatchObject({ status: "TIMED_OUT", answer: null });
  });

  it("never relays a malformed answer", async () => {
    const { h } = setup();
    const run = await h.start(call);
    await h.manager.deliverEvent(`answer.${run.runId}`, { text: "wrong field" });
    expect(h.run(run.runId).output).toMatchObject({ status: "TIMED_OUT" });
  });
});

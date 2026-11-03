import { describe, expect, it } from "vitest";
import { testActuator } from "@actuate/cli/testing";
import actuator from "../approve-message/actuator.js";

const call = { to: "aina@example.com", draft: "Sorry about the delay. Here is 20% off your next order.", context: "Late delivery, order 2291", subject: "About your order" };
const setup = () => testActuator(actuator, { config: { approver: "lead-chat" } });

describe("approve-message", () => {
  it("sends nothing until a person approves, then sends the draft", async () => {
    const t = setup();
    const run = await t.start(call);
    expect(run.status).toBe("WAITING");
    expect(t.messages).toHaveLength(0);
    expect(t.approvals[0]).toMatchObject({ notify: "lead-chat", message: expect.stringContaining(call.draft) });
    await t.approve();
    expect(t.messages).toMatchObject([{ to: call.to, text: call.draft, options: { subject: "About your order" } }]);
    expect(t.run(run.runId).output).toEqual({ status: "SENT", messageId: run.runId, sentText: call.draft, edited: false });
    expect(t.rows("outgoing_messages")[0]).toMatchObject({ status: "SENT", sent_text: call.draft });
  });

  it("sends the reviewer's edit when they approve through the link with a note", async () => {
    const t = setup();
    const run = await t.start(call);
    await t.approve("human-review", { note: "Sorry about the delay. Here is 10% off your next order." });
    expect(t.messages[0]!.text).toBe("Sorry about the delay. Here is 10% off your next order.");
    expect(t.run(run.runId).output).toMatchObject({ status: "SENT", edited: true });
  });

  it("never sends a rejected or expired message", async () => {
    const rejected = setup();
    const run = await rejected.start(call);
    await rejected.reject("human-review", { note: "We don't discount for this" });
    expect(rejected.run(run.runId).output).toEqual({ status: "REJECTED", messageId: run.runId, edited: false, reviewerNote: "We don't discount for this" });

    const expired = setup();
    const run2 = await expired.start(call);
    await expired.advance("4 hours");
    expect(expired.run(run2.runId).output).toEqual({ status: "EXPIRED", messageId: run2.runId, edited: false });
    expect(expired.rows("outgoing_messages")[0]).toMatchObject({ status: "EXPIRED", sent_text: null });
    expect([...rejected.messages, ...expired.messages]).toHaveLength(0);
  });

  it("retries a failed send and sends once, with the same idempotency key", async () => {
    const attempts: Array<string | undefined> = [];
    const t = testActuator(actuator, {
      config: { approver: "lead-chat" },
      providers: {
        messaging: {
          async send(_to, _text, options) {
            attempts.push(options?.idempotencyKey);
            if (attempts.length === 1) throw new Error("provider timeout");
            return { id: "msg-1", channel: "test" };
          },
        },
      },
    });
    const run = await t.start(call);
    await t.approve();
    expect(t.run(run.runId).status).toBe("WAITING"); // retrying after a backoff
    await t.advance("1 second");
    expect(t.run(run.runId).output).toMatchObject({ status: "SENT" });
    expect(attempts).toEqual([`${run.runId}:send-message:send:0`, `${run.runId}:send-message:send:0`]);
  });
});

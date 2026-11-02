import { describe, expect, it } from "vitest";
import actuator from "../schedule-follow-up/actuator.js";
import { DAY, HOUR, T0, fakeProviders, harness } from "./harness.js";

const at = (ms: number) => new Date(T0 + ms).toISOString();
const call = (sendAt: string) => ({ contact: "aina-chat", sendAt, message: "Hi Aina, your beans are back in stock!" });

function setup() {
  const fakes = fakeProviders();
  return { ...fakes, h: harness(actuator, { providers: fakes.providers }) };
}

describe("schedule-follow-up", () => {
  it("sends the exact message at the requested time", async () => {
    const { h, sent } = setup();
    const run = await h.start(call("2026-11-05T10:00:00+08:00"));
    expect(run.status).toBe("WAITING");
    expect(h.rows("follow_ups")[0]).toMatchObject({ status: "SCHEDULED", send_at: Date.parse("2026-11-05T02:00:00Z") });
    await h.advance(3 * DAY + 2 * HOUR - 1);
    expect(sent).toHaveLength(0);
    await h.advance(1);
    expect(sent).toEqual([{ to: "aina-chat", text: "Hi Aina, your beans are back in stock!" }]);
    expect(h.run(run.runId).output).toEqual({ status: "SENT", followUpId: run.runId, sendAt: "2026-11-05T02:00:00.000Z" });
    expect(h.rows("follow_ups")[0]).toMatchObject({ status: "SENT" });
  });

  it("is cancelled when the customer replies first", async () => {
    const { h, sent } = setup();
    const run = await h.start(call(at(2 * DAY)));
    await h.advance(DAY);
    await h.manager.deliverEvent(`reply.${run.runId}`, { text: "Already bought some, thanks" });
    expect(h.run(run.runId).output).toMatchObject({ status: "CANCELLED", reason: "The customer replied first." });
    await h.advance(2 * DAY);
    expect(sent).toHaveLength(0);
    expect(h.rows("follow_ups")[0]).toMatchObject({ status: "CANCELLED" });
  });

  it("refuses times in the past, too soon, or beyond the limit, with a reason the agent can act on", async () => {
    const { h, sent } = setup();
    for (const [sendAt, reason] of [
      [at(-HOUR), /at least 5 minutes in the future/],
      [at(60_000), /at least 5 minutes/],
      [at(91 * DAY), /within 90 days/],
    ] as const) {
      const run = await h.start(call(sendAt));
      expect(run.output).toMatchObject({ status: "INVALID_TIME", reason: expect.stringMatching(reason) });
    }
    expect(sent).toHaveLength(0);
    expect(h.manager.listTables()).toEqual(["follow_ups"]);
    expect(h.rows("follow_ups")).toHaveLength(0);
  });

  it("rejects a time without a timezone offset at the schema", async () => {
    await expect(setup().h.start(call("2026-11-05 10:00"))).rejects.toThrow();
  });
});

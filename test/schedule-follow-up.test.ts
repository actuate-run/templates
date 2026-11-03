import { describe, expect, it } from "vitest";
import { testActuator } from "@actuate/cli/testing";
import actuator from "../schedule-follow-up/actuator.js";

const NOW = Date.parse("2026-11-02T00:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(NOW + ms).toISOString();
const call = (sendAt: string) => ({ contact: "aina-chat", sendAt, message: "Hi Aina, your beans are back in stock!" });
const setup = (opts: Parameters<typeof testActuator>[1] = {}) => testActuator(actuator, { now: NOW, ...opts });

describe("schedule-follow-up", () => {
  it("sends the exact message at the requested time", async () => {
    const t = setup();
    const run = await t.start(call("2026-11-05T10:00:00+08:00"));
    expect(run.status).toBe("WAITING");
    expect(t.rows("follow_ups")[0]).toMatchObject({ status: "SCHEDULED", send_at: Date.parse("2026-11-05T02:00:00Z") });
    await t.advance(3 * DAY + 2 * HOUR - 1);
    expect(t.messages).toHaveLength(0);
    await t.advance(1);
    expect(t.messages).toMatchObject([{ to: "aina-chat", text: "Hi Aina, your beans are back in stock!" }]);
    expect(t.run(run.runId).output).toEqual({ status: "SENT", followUpId: run.runId, sendAt: "2026-11-05T02:00:00.000Z" });
    expect(t.rows("follow_ups")[0]).toMatchObject({ status: "SENT" });
  });

  it("is cancelled when the customer replies first", async () => {
    const t = setup();
    const run = await t.start(call(at(2 * DAY)));
    await t.advance("1 day");
    await t.event(`reply.${run.runId}`, { text: "Already bought some, thanks" });
    expect(t.run(run.runId).output).toMatchObject({ status: "CANCELLED", reason: "The customer replied first." });
    await t.advance("2 days");
    expect(t.messages).toHaveLength(0);
    expect(t.rows("follow_ups")[0]).toMatchObject({ status: "CANCELLED" });
  });

  it("refuses times in the past, too soon, or beyond the limit, with a reason the agent can act on", async () => {
    const t = setup();
    for (const [sendAt, reason] of [
      [at(-HOUR), /at least 5 minutes in the future/],
      [at(60_000), /at least 5 minutes/],
      [at(91 * DAY), /within 90 days/],
    ] as const) {
      const run = await t.start(call(sendAt));
      expect(run.output).toMatchObject({ status: "INVALID_TIME", reason: expect.stringMatching(reason) });
    }
    expect(t.messages).toHaveLength(0);
    expect(t.manager.listTables()).toEqual(["follow_ups"]);
    expect(t.rows("follow_ups")).toHaveLength(0);
  });

  it("waits up to maxDaysAhead on a plan without a wait limit (Maker)", async () => {
    const t = setup({ plan: "maker" });
    const run = await t.start(call(at(60 * DAY)));
    await t.advance("60 days");
    expect(t.run(run.runId).output).toMatchObject({ status: "SENT" });
    expect(t.messages).toHaveLength(1);
  });

  it("fails loudly, rather than sending early, when the wait is longer than the plan allows (Sandbox: 7 days)", async () => {
    const t = setup({ plan: "sandbox" });
    const run = await t.start(call(at(8 * DAY)));
    expect(t.run(run.runId)).toMatchObject({ status: "FAILED", error: { message: expect.stringMatching(/"wait-for-reply" waits 691200s, longer than this plan allows/) } });
    expect(t.messages).toHaveLength(0);
  });

  it("rejects a time without a timezone offset at the schema", async () => {
    await expect(setup().start(call("2026-11-05 10:00"))).rejects.toThrow(/sendAt/);
  });
});

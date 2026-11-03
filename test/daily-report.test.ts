import { describe, expect, it } from "vitest";
import { testActuator } from "@actuate/cli/testing";
import actuator from "../daily-report/actuator.js";

const setup = (config: Record<string, unknown> = {}) =>
  testActuator(actuator, { config: { reportTo: "owner-chat", ...config }, now: "2026-11-02T00:00:00Z" });

describe("daily-report", () => {
  it("is scheduled at 09:00 MYT and accepts the empty cron input", () => {
    expect(actuator.cron).toEqual(["0 1 * * *"]);
    expect(actuator.input.safeParse({}).success).toBe(true);
  });

  it("summarises the last 24 hours and compares with the day before", async () => {
    const t = setup({ topTypes: 2 });
    await t.start({ event: { type: "order", amount: 10 } }); // day before
    await t.advance("24 hours");
    for (const event of [
      { type: "order", amount: 25 },
      { type: "order", amount: 15.5 },
      { type: "signup" },
      { type: "signup" },
      { type: "refund", amount: 5 },
    ]) {
      expect((await t.start({ event })).output).toEqual({ recorded: event.type });
    }
    await t.advance("1 hour"); // 2026-11-03T01:00Z, the cron firing

    const run = await t.cron();
    expect(run.output).toEqual({ total: 5, sent: true });
    expect(t.messages).toMatchObject([
      {
        to: "owner-chat",
        options: { subject: expect.stringContaining("Daily report") },
        text: [
          "📊 Daily report, Tuesday, 3 November 2026",
          "5 events in the last 24 hours (+4 vs the day before)",
          "• order: 2 (total 40.50)",
          "• signup: 2",
          "• and 1 more types",
        ].join("\n"),
      },
    ]);
    expect(t.rows("reports")).toEqual([expect.objectContaining({ run_id: run.runId, total: 5, sent: 1 })]);
  });

  it("reports a quiet day, or skips it when configured", async () => {
    const loud = setup();
    expect((await loud.cron()).output).toEqual({ total: 0, sent: true });
    expect(loud.messages[0]!.text).toMatch(/0 events in the last 24 hours \(\+0/);

    const quiet = setup({ skipEmpty: true });
    expect((await quiet.cron()).output).toEqual({ total: 0, sent: false });
    expect(quiet.messages).toHaveLength(0);
    expect(quiet.rows("reports")).toEqual([expect.objectContaining({ sent: 0 })]);
  });
});

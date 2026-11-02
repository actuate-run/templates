import { describe, expect, it } from "vitest";
import actuator from "../daily-report/actuator.js";
import { HOUR, fakeProviders, harness } from "./harness.js";

const cron = { kind: "cron", cron: "0 1 * * *" } as const;

function setup(config: Record<string, unknown> = {}) {
  const fakes = fakeProviders();
  return { ...fakes, h: harness(actuator, { providers: fakes.providers, config: { reportTo: "owner-chat", ...config } }) };
}

describe("daily-report", () => {
  it("is scheduled at 09:00 MYT and accepts the empty cron input", () => {
    expect(actuator.cron).toEqual(["0 1 * * *"]);
    expect(actuator.input.safeParse({}).success).toBe(true);
  });

  it("summarises the last 24 hours and compares with the day before", async () => {
    const { h, sent } = setup({ topTypes: 2 });
    await h.start({ event: { type: "order", amount: 10 } }); // day before
    await h.advance(24 * HOUR);
    for (const event of [
      { type: "order", amount: 25 },
      { type: "order", amount: 15.5 },
      { type: "signup" },
      { type: "signup" },
      { type: "refund", amount: 5 },
    ]) {
      expect((await h.start({ event })).output).toEqual({ recorded: event.type });
    }
    await h.advance(HOUR); // 2026-11-03T01:00Z, the cron firing

    const run = await h.start({}, cron);
    expect(run.output).toEqual({ total: 5, sent: true });
    expect(sent).toEqual([
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
    expect(h.rows("reports")).toEqual([expect.objectContaining({ run_id: run.runId, total: 5, sent: 1 })]);
  });

  it("reports a quiet day, or skips it when configured", async () => {
    const loud = setup();
    expect((await loud.h.start({}, cron)).output).toEqual({ total: 0, sent: true });
    expect(loud.sent[0]!.text).toMatch(/0 events in the last 24 hours \(\+0/);

    const quiet = setup({ skipEmpty: true });
    expect((await quiet.h.start({}, cron)).output).toEqual({ total: 0, sent: false });
    expect(quiet.sent).toHaveLength(0);
    expect(quiet.h.rows("reports")).toEqual([expect.objectContaining({ sent: 0 })]);
  });
});

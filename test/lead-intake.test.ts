import { describe, expect, it } from "vitest";
import { testActuator } from "@actuate/cli/testing";
import actuator from "../lead-intake/actuator.js";

const lead = { name: "Mei", email: "mei@example.com", interest: "Do you run group classes?" };
const setup = (config: Record<string, unknown> = {}) => testActuator(actuator, { config });

describe("lead-intake", () => {
  it("saves the lead and sends the day 1 email as HTML", async () => {
    const t = setup();
    const run = await t.start({ ...lead, interest: "<b>classes</b>?" });
    expect(run.status).toBe("WAITING");
    expect(t.rows("leads")).toEqual([expect.objectContaining({ id: run.runId, email: "mei@example.com", status: "NEW" })]);
    expect(t.messages[0]).toMatchObject({ to: "mei@example.com", options: { format: "html", subject: expect.stringContaining("Studio Gerak") } });
    expect(t.messages[0]!.text).toContain("&lt;b&gt;classes&lt;/b&gt;?");
  });

  it("stops at once when the lead replies before day 3", async () => {
    const t = setup({ notifyTo: "sales-chat" });
    const run = await t.start(lead);
    await t.advance("1 day");
    await t.event(`reply.${run.runId}`, { subject: "Re: Yes" });
    expect(t.run(run.runId).output).toEqual({ leadId: run.runId, status: "REPLIED" });
    expect(t.messages.map((m) => m.to)).toEqual(["mei@example.com", "sales-chat"]);
    expect(t.rows("leads")[0]).toMatchObject({ status: "REPLIED" });
  });

  it("follows up on day 3, and a reply on day 5 cancels the rest", async () => {
    const t = setup();
    const run = await t.start(lead);
    await t.advance("2 days");
    expect(t.messages[1]!.text).toMatch(/any questions/);
    await t.advance("2 days");
    await t.event(`reply.${run.runId}`, {});
    expect(t.run(run.runId).output).toMatchObject({ status: "REPLIED" });
    await t.advance("10 days");
    expect(t.messages).toHaveLength(2);
  });

  it("marks the lead COLD after a week of silence, firing both waits in one advance", async () => {
    const t = setup();
    const run = await t.start(lead);
    await t.advance("6 days");
    expect(t.run(run.runId).output).toEqual({ leadId: run.runId, status: "COLD" });
    expect(t.rows("leads")[0]).toMatchObject({ status: "COLD" });
    expect(t.messages).toHaveLength(2);
    expect(t.usage(run.runId).passes).toBe(3); // start, day 3, day 7: it hibernates in between
  });

  it("rejects an invalid email before anything runs", async () => {
    await expect(setup().start({ ...lead, email: "not-an-email" })).rejects.toThrow(/email/);
  });
});

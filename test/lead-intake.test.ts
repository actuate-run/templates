import { describe, expect, it } from "vitest";
import actuator from "../lead-intake/actuator.js";
import { DAY, fakeProviders, harness } from "./harness.js";

const lead = { name: "Mei", email: "mei@example.com", interest: "Do you run group classes?" };

function setup(config: Record<string, unknown> = {}) {
  const fakes = fakeProviders();
  return { ...fakes, h: harness(actuator, { providers: fakes.providers, config }) };
}

describe("lead-intake", () => {
  it("saves the lead and sends the day 1 email as HTML", async () => {
    const { h, sent } = setup();
    const run = await h.start({ ...lead, interest: "<b>classes</b>?" });
    expect(run.status).toBe("WAITING");
    expect(h.rows("leads")).toEqual([expect.objectContaining({ id: run.runId, email: "mei@example.com", status: "NEW" })]);
    expect(sent[0]).toMatchObject({ to: "mei@example.com", options: { format: "html", subject: expect.stringContaining("Studio Gerak") } });
    expect(sent[0]!.text).toContain("&lt;b&gt;classes&lt;/b&gt;?");
  });

  it("stops at once when the lead replies before day 3", async () => {
    const { h, sent } = setup({ notifyTo: "sales-chat" });
    const run = await h.start(lead);
    await h.advance(DAY);
    await h.manager.deliverEvent(`reply.${run.runId}`, { subject: "Re: Yes" });
    expect(h.run(run.runId).output).toEqual({ leadId: run.runId, status: "REPLIED" });
    expect(sent.map((m) => m.to)).toEqual(["mei@example.com", "sales-chat"]);
    expect(h.rows("leads")[0]).toMatchObject({ status: "REPLIED" });
  });

  it("follows up on day 3, and a reply on day 5 cancels the rest", async () => {
    const { h, sent } = setup();
    const run = await h.start(lead);
    await h.advance(2 * DAY);
    expect(sent[1]!.text).toMatch(/any questions/);
    await h.advance(2 * DAY);
    await h.manager.deliverEvent(`reply.${run.runId}`, {});
    expect(h.run(run.runId).output).toMatchObject({ status: "REPLIED" });
    await h.advance(10 * DAY);
    expect(sent).toHaveLength(2);
  });

  it("marks the lead COLD after a week of silence", async () => {
    const { h, sent } = setup();
    const run = await h.start(lead);
    await h.advance(2 * DAY);
    await h.advance(4 * DAY);
    expect(h.run(run.runId).output).toEqual({ leadId: run.runId, status: "COLD" });
    expect(h.rows("leads")[0]).toMatchObject({ status: "COLD" });
    expect(sent).toHaveLength(2);
  });

  it("rejects an invalid email before anything runs", async () => {
    await expect(setup().h.start({ ...lead, email: "not-an-email" })).rejects.toThrow();
  });
});

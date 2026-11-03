import { describe, expect, it } from "vitest";
import { testActuator } from "@actuate/cli/testing";
import actuator from "../github-release-telegram/actuator.js";

// Trimmed from a real GitHub `release` webhook; extra fields must be ignored.
const payload = (overrides: Record<string, unknown> = {}, action = "published") => ({
  action,
  release: {
    id: 1001,
    tag_name: "v1.2.0",
    name: "Faster replays",
    body: "## Changes\r\n- Replays are 2x faster\r\n- Fixed a bug",
    html_url: "https://github.com/acme/widget/releases/tag/v1.2.0",
    draft: false,
    prerelease: false,
    author: { login: "octocat", id: 1 },
    assets: [],
    ...overrides,
  },
  repository: { full_name: "acme/widget", private: false },
  sender: { login: "octocat" },
});
const setup = (config: Record<string, unknown> = {}) => testActuator(actuator, { config: { chatId: "@acme_releases", ...config } });

describe("github-release-telegram", () => {
  it("posts a formatted message for a published release", async () => {
    const t = setup();
    const run = await t.start(payload(), { trigger: "webhook" });
    expect(run.output).toEqual({ posted: true, messageId: "msg-1", tag: "v1.2.0" });
    expect(t.messages).toMatchObject([
      {
        to: "@acme_releases",
        options: { channel: "telegram" },
        text:
          "🚀 acme/widget v1.2.0\n\nFaster replays\n\n## Changes\n- Replays are 2x faster\n- Fixed a bug\n\n" +
          "by @octocat\n\nhttps://github.com/acme/widget/releases/tag/v1.2.0",
      },
    ]);
  });

  it("announces each release once, even when GitHub redelivers the webhook", async () => {
    const t = setup();
    await t.start(payload());
    expect((await t.start(payload())).output).toEqual({ posted: false, reason: "already announced" });
    expect(t.messages).toHaveLength(1);
  });

  it("returns the first run for a redelivery with the same X-GitHub-Delivery id (the run's idempotency key)", async () => {
    const t = setup();
    const first = await t.start(payload(), { trigger: "webhook", idempotencyKey: "delivery-72d3162e" });
    const again = await t.start(payload(), { trigger: "webhook", idempotencyKey: "delivery-72d3162e" });
    expect(again.runId).toBe(first.runId);
    expect(t.messages).toHaveLength(1);
  });

  it("retries a failed post, backing off, and posts once", async () => {
    let calls = 0;
    const t = testActuator(actuator, {
      config: { chatId: "@acme_releases" },
      providers: {
        messaging: {
          async send() {
            if (++calls < 3) throw new Error("Telegram 502");
            return { id: "tg-1", channel: "telegram" };
          },
        },
      },
    });
    const run = await t.start(payload(), { trigger: "webhook" });
    await t.advance("5 seconds");
    expect(t.run(run.runId).status).toBe("WAITING"); // second retry waits 10 seconds
    await t.advance("10 seconds");
    expect(t.run(run.runId).output).toEqual({ posted: true, messageId: "tg-1", tag: "v1.2.0" });
    expect(calls).toBe(3);
  });

  it("skips other actions, drafts and (by default) pre-releases", async () => {
    const t = setup();
    expect((await t.start(payload({}, "created"))).output).toMatchObject({ posted: false, reason: 'action "created" ignored' });
    expect((await t.start(payload({ draft: true }))).output).toMatchObject({ reason: "draft" });
    expect((await t.start(payload({ prerelease: true }))).output).toMatchObject({ reason: "pre-release" });
    expect(t.messages).toHaveLength(0);
  });

  it("posts pre-releases when configured, and truncates long notes", async () => {
    const t = setup({ includePrereleases: true, maxNotesLength: 10 });
    await t.start(payload({ prerelease: true, name: null, body: "abcdefghijklmnop", author: null }));
    expect(t.messages[0]!.text).toBe(
      "🚀 acme/widget v1.2.0 (pre-release)\n\nabcdefghij…\n\nhttps://github.com/acme/widget/releases/tag/v1.2.0",
    );
  });
});

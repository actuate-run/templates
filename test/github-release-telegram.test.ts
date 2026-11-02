import { describe, expect, it } from "vitest";
import actuator from "../github-release-telegram/actuator.js";
import { fakeProviders, harness } from "./harness.js";

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

function setup(config: Record<string, unknown> = {}) {
  const fakes = fakeProviders();
  return { ...fakes, h: harness(actuator, { providers: fakes.providers, config: { chatId: "@acme_releases", ...config } }) };
}

describe("github-release-telegram", () => {
  it("posts a formatted message for a published release", async () => {
    const { h, sent } = setup();
    const run = await h.start(payload(), { kind: "webhook" });
    expect(run.output).toEqual({ posted: true, messageId: "msg-1", tag: "v1.2.0" });
    expect(sent).toEqual([
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
    const { h, sent } = setup();
    await h.start(payload());
    expect((await h.start(payload())).output).toEqual({ posted: false, reason: "already announced" });
    expect(sent).toHaveLength(1);
  });

  it("skips other actions, drafts and (by default) pre-releases", async () => {
    const { h, sent } = setup();
    expect((await h.start(payload({}, "created"))).output).toMatchObject({ posted: false, reason: 'action "created" ignored' });
    expect((await h.start(payload({ draft: true }))).output).toMatchObject({ reason: "draft" });
    expect((await h.start(payload({ prerelease: true }))).output).toMatchObject({ reason: "pre-release" });
    expect(sent).toHaveLength(0);
  });

  it("posts pre-releases when configured, and truncates long notes", async () => {
    const { h, sent } = setup({ includePrereleases: true, maxNotesLength: 10 });
    await h.start(payload({ prerelease: true, name: null, body: "abcdefghijklmnop", author: null }));
    expect(sent[0]!.text).toBe(
      "🚀 acme/widget v1.2.0 (pre-release)\n\nabcdefghij…\n\nhttps://github.com/acme/widget/releases/tag/v1.2.0",
    );
  });
});

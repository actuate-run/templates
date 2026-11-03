import { test } from "node:test";
import assert from "node:assert/strict";
import { testActuator } from "@actuate/cli/testing";
import actuator from "./actuator.js";

const config = { chatId: "@acme_releases" };
// Trimmed from GitHub's `release` webhook; fields the input schema doesn't name are ignored.
const payload = {
  action: "published",
  release: {
    id: 1001,
    tag_name: "v1.2.0",
    name: "Faster replays",
    body: "- Replays are 2x faster",
    html_url: "https://github.com/acme/widget/releases/tag/v1.2.0",
    draft: false,
    prerelease: false,
    author: { login: "octocat" },
  },
  repository: { full_name: "acme/widget" },
};

test("posts a published release to Telegram", async () => {
  const t = testActuator(actuator, { config });
  const run = await t.start(payload, { trigger: "webhook" });
  assert.deepEqual(run.output, { posted: true, messageId: "msg-1", tag: "v1.2.0" });
  assert.equal(t.messages[0]!.to, "@acme_releases");
  assert.equal(
    t.messages[0]!.text,
    "🚀 acme/widget v1.2.0\n\nFaster replays\n\n- Replays are 2x faster\n\nby @octocat\n\nhttps://github.com/acme/widget/releases/tag/v1.2.0",
  );
});

test("announces a release once, even when GitHub redelivers the webhook", async () => {
  const t = testActuator(actuator, { config });
  await t.start(payload, { trigger: "webhook" });
  const again = await t.start(payload, { trigger: "webhook" });
  assert.deepEqual(again.output, { posted: false, reason: "already announced" });
  assert.equal(t.messages.length, 1);
});

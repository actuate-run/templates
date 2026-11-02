import { defineActuator, z } from "@actuate/sdk";

export const ConfigSchema = z.object({
  chatId: z.string().min(1).describe("Telegram chat or channel ID, e.g. -1001234567890 or @my_channel"),
  includePrereleases: z.boolean().default(false),
  includeDrafts: z.boolean().default(false),
  // Telegram caps a message at 4096 characters; long release notes are cut here.
  maxNotesLength: z.number().int().min(0).max(3500).default(1200),
});

/** The parts of GitHub's `release` webhook payload this actuator reads. Other fields are ignored. */
export const InputSchema = z.object({
  action: z.string(),
  release: z.object({
    id: z.number(),
    tag_name: z.string(),
    name: z.string().nullable(),
    body: z.string().nullable(),
    html_url: z.url(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    author: z.object({ login: z.string() }).nullable().optional(),
  }),
  repository: z.object({ full_name: z.string() }),
});

type Release = z.output<typeof InputSchema>["release"];

function formatRelease(repo: string, release: Release, maxNotes: number): string {
  const title = release.name?.trim() || release.tag_name;
  const notes = (release.body ?? "").replace(/\r\n/g, "\n").trim();
  const clipped = notes.length > maxNotes ? `${notes.slice(0, maxNotes).trimEnd()}…` : notes;
  return [
    `🚀 ${repo} ${release.tag_name}${release.prerelease ? " (pre-release)" : ""}`,
    title !== release.tag_name ? title : "",
    clipped,
    release.author ? `by @${release.author.login}` : "",
    release.html_url,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export default defineActuator({
  name: "github_release_telegram",
  description: "Posts a formatted Telegram message when a GitHub release is published. Point a GitHub release webhook at it.",
  config: ConfigSchema,
  input: InputSchema,
  capabilities: ["messaging"],
  async run(ctx, input, config) {
    const { action, release, repository } = input;
    if (action !== "published") return { posted: false, reason: `action "${action}" ignored` };
    if (release.draft && !config.includeDrafts) return { posted: false, reason: "draft" };
    if (release.prerelease && !config.includePrereleases) return { posted: false, reason: "pre-release" };

    await ctx.db.migrate([
      `CREATE TABLE announced_releases (release_id INTEGER PRIMARY KEY, repo TEXT NOT NULL, tag TEXT NOT NULL, announced_at TEXT NOT NULL)`,
    ]);

    // GitHub redelivers webhooks on timeouts, and people click "Redeliver". Announce each release once.
    const firstTime = await ctx.step.do("claim-release", async () => {
      const claimed = await ctx.db.sql`INSERT INTO announced_releases (release_id, repo, tag, announced_at)
        VALUES (${release.id}, ${repository.full_name}, ${release.tag_name}, ${new Date().toISOString()})
        ON CONFLICT (release_id) DO NOTHING RETURNING release_id`;
      return claimed.length === 1;
    });
    if (!firstTime) return { posted: false, reason: "already announced" };

    const receipt = await ctx.step.do("post-to-telegram", { retries: 3, backoff: "5 seconds" }, () =>
      ctx.messaging.send(config.chatId, formatRelease(repository.full_name, release, config.maxNotesLength), {
        channel: "telegram",
      }),
    );
    return { posted: true, messageId: receipt.id, tag: release.tag_name };
  },
});

# github-release-telegram

Posts a tidy Telegram message every time you publish a GitHub release: repository, tag, title, release notes (trimmed) and a link. Drafts and pre-releases are skipped unless you opt in, and each release is announced once even when GitHub redelivers the webhook.

```sh
npm create actuate my-bot -- --template github-release-telegram
cd my-bot && npm install && npx actuate dev
```

## Configuration

| Key | Default | What it does |
| --- | --- | --- |
| `chatId` | required | Telegram chat or channel, e.g. `-1001234567890` or `@my_channel`. Add your bot to it first. |
| `includePrereleases` | `false` | Also announce pre-releases. |
| `includeDrafts` | `false` | Also announce drafts (GitHub only sends these for `created` / `edited`, so rarely useful). |
| `maxNotesLength` | `1200` | Release notes longer than this are cut with `…`. |

Capability: `messaging` with the Telegram provider (a bot token from @BotFather).

## Triggering a run

In your repository, go to **Settings → Webhooks → Add webhook**:

- **Payload URL:** your actuator's `/webhook` URL, as `actuate deploy` prints it. Nothing appended.
- **Content type:** `application/json`.
- **Secret:** your actuator's webhook secret (on the platform: the dashboard's **Connect** tab; self-hosted: `ACTUATE_WEBHOOK_SECRET`). GitHub signs every delivery with it (`X-Hub-Signature-256`) and the actuator checks the signature, so the secret itself never travels or lands in a log.
- **Events:** "Let me select individual events" → **Releases** only.

Don't put the secret in the URL as `?secret=`: URLs end up in logs, and the platform has deprecated it. If you set the hook up that way before, switch to the **Secret** field and rotate the webhook secret.

Each delivery starts one run. Only `action: "published"` is announced; `created`, `edited`, `deleted` and the rest return `posted: false`. GitHub's initial `ping` delivery does not match the release schema and is rejected with a 400, which is harmless.

Try it locally with a trimmed payload:

```sh
curl -X POST localhost:8787/run -H 'content-type: application/json' -d '{
  "action": "published",
  "release": {
    "id": 1, "tag_name": "v1.0.0", "name": "First release", "body": "- It works",
    "html_url": "https://github.com/acme/widget/releases/tag/v1.0.0",
    "draft": false, "prerelease": false, "author": { "login": "octocat" }
  },
  "repository": { "full_name": "acme/widget" }
}'
```

This actuator does not wait for events; each run finishes immediately.

## Data

Table `announced_releases`: `release_id`, `repo`, `tag`, `announced_at`. It is how redeliveries are recognised.

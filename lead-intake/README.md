# lead-intake

An MCP tool an agent calls to hand over a sales lead. It saves the lead, emails them now, follows up once after two days, and stops the moment they reply. The agent's job ends at one tool call; the follow-up schedule lives in code, not in the agent's memory.

```
save → day-1 email → wait for reply (2 days) ─┬─ reply → REPLIED
                                              └─ follow-up email → wait for reply (4 days) ─┬─ reply → REPLIED
                                                                                            └─ COLD
```

The run hibernates between emails and costs nothing while it waits.

```sh
npm create actuate my-bot -- --template lead-intake
cd my-bot && npm install && npx actuate dev
npx actuate test   # actuator.test.ts: fake providers and a test clock, no setup
```

## Configuration

| Key | Default | What it does |
| --- | --- | --- |
| `businessName` | `"Studio Gerak"` | Signs the emails. |
| `notifyTo` | `""` | Who on your team hears when a lead replies. Empty: nobody. |

Capability: `messaging`, with an email provider (Resend by default in `.env.example`). Emails are sent as HTML (`format: "html"`); the lead's own words are escaped.

## How an agent uses this

```json
{ "method": "tools/call", "params": { "name": "lead_intake", "arguments": { "name": "Mei", "email": "mei@example.com", "interest": "Do you run group classes?" } } }
```

The email is validated before anything runs, so a made-up address is rejected with a schema error the agent can fix. The call returns at once with status `WAITING` and a `runId`; the agent can tell the visitor "we've emailed you". A week later at most, `actuate_get_run` gives:

```json
{ "leadId": "run_019a...", "status": "REPLIED" }
```

The actuator declares `idempotencyKey: ["email"]`, so a call that sends no idempotency key of its own gets one made from the email address. Calling the tool again for the same email, while that lead's emails are still going out or within 24 hours after the run ended, returns the same run: the lead is saved once and never gets a second welcome email. A failed or cancelled run never matches. The key uses the email exactly as sent, so `Mei@example.com` and `mei@example.com` count as two leads. To start a new sequence anyway, send a new explicit idempotency key.

The tool is annotated `openWorld` (it emails people), and the declared key also marks it `idempotent`.

## Events it waits for

| Event | Sent by | Effect |
| --- | --- | --- |
| `reply.<runId>` | Your inbound-email webhook (for example a Resend or Postmark inbound route that maps the reply to the lead's run ID, e.g. via a `reply+<runId>@` address) | Ends the current wait and marks the lead REPLIED. No further emails are sent. |

Locally: `curl -X POST localhost:8787/events/reply.<runId> -d '{}'`.

## Data

Table `leads`: `id` (the run ID), `name`, `email`, `interest`, `status` (`NEW`, `REPLIED`, `COLD`), `created_at`, `updated_at`.

The landing page's "Lead follow-up" flow is an excerpt of this file.

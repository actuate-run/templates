# daily-report

A morning summary of what happened yesterday. Other systems (your app, other actuators, an AI agent) record events into this actuator's SQLite database during the day; every morning at 09:00 Malaysia time a cron run counts them by type, compares with the day before, and sends the report.

```
{event: {...}}  → insert into events
cron 0 1 * * *  → fix the 24 h window → count by type → send report → log it in reports
```

```sh
npm create actuate my-bot -- --template daily-report
cd my-bot && npm install && npx actuate dev
```

## Configuration

| Key | Default | What it does |
| --- | --- | --- |
| `reportTo` | required | Chat ID, phone or email that receives the report. |
| `title` | `"Daily report"` | First line of the message, and the email subject. |
| `timeZone` | `"Asia/Kuala_Lumpur"` | Used for the date in the report. |
| `topTypes` | `5` | How many event types to list; the rest are summarised as "and N more types". |
| `skipEmpty` | `false` | Send nothing on days with no events. |

The schedule is `cron: ["0 1 * * *"]` in `actuator.ts` (cron runs in UTC; 01:00 UTC is 09:00 MYT). Change it there.

Capability: `messaging` (Telegram, WhatsApp, or email via Resend).

## Triggering a run

**Record an event** whenever something happens:

```sh
curl -X POST localhost:8787/run -H 'content-type: application/json' \
  -d '{ "event": { "type": "order", "amount": 42.5, "detail": "order-1001" } }'
```

`amount` is optional and summed per type.

**Send the report** happens on the cron schedule with input `{}`. To send one now, post `{}`:

```sh
curl -X POST localhost:8787/run -H 'content-type: application/json' -d '{}'
```

`actuate dev` runs workerd with `--test-scheduled`, so you can also fire the cron with `curl 'localhost:8787/__scheduled?cron=0+1+*+*+*'`.

This actuator does not wait for events.

## Data

- `events`: `type`, `amount`, `detail`, `at` (epoch ms).
- `reports`: one row per report run with the window, the total, and whether it was sent.

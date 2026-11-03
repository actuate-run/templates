# schedule-follow-up

An MCP tool for "remind this customer on Friday at 10am about X". The agent passes the exact text and a time; the actuator checks the time, sleeps until then, and sends, unless the customer replies first. Agents have no clock they can trust and no way to wake themselves up later; this tool does both.

```
validate time (future, ≥ minMinutesAhead, ≤ maxDaysAhead) ─ invalid → INVALID_TIME + reason
save → wait for reply until sendAt ─┬─ reply → CANCELLED
                                    └─ sendAt → send → SENT
```

The wait is one `waitForEvent({ event: "reply.<runId>", until: sendAt })`: it sleeps until the send time, and a reply ends it early. If `maxDaysAhead` is longer than your plan's longest wait, the run fails loudly instead of sending early.

```sh
npm create actuate my-bot -- --template schedule-follow-up
cd my-bot && npm install && npx actuate dev
npx actuate test   # actuator.test.ts: fake providers and a test clock, no setup
```

## Configuration

| Key | Default | What it does |
| --- | --- | --- |
| `maxDaysAhead` | `90` | The furthest ahead a follow-up may be scheduled. |
| `minMinutesAhead` | `5` | Anything sooner is refused; the agent should just reply now. |

Capability: `messaging`.

## How an agent uses this

```json
{ "method": "tools/call", "params": { "name": "schedule_follow_up", "arguments": {
  "contact": "123456789", "sendAt": "2026-11-20T10:00:00+08:00", "message": "Hi Aina, your beans are back in stock!" } } }
```

`sendAt` must be ISO 8601 with a timezone offset, so "10am" can't silently mean UTC. A bad time completes at once:

```json
{ "status": "INVALID_TIME", "followUpId": "run_019a...", "sendAt": "2027-03-01T02:00:00.000Z", "reason": "sendAt must be within 90 days." }
```

A good one returns `WAITING` with a `runId`; later `actuate_get_run` returns `SENT` or `CANCELLED`:

```json
{ "status": "SENT", "followUpId": "run_019a...", "sendAt": "2026-11-20T02:00:00.000Z" }
```

The tool is annotated `openWorld` (it messages customers) and not `idempotent`: calling it twice schedules two messages.

To cancel a follow-up yourself, cancel the run from the dashboard (or `POST /runs/<runId>/cancel`).

## Events it waits for

| Event | Sent by | Effect |
| --- | --- | --- |
| `reply.<runId>` | Your inbound messaging webhook, or the agent's own backend when the customer writes back | Cancels the follow-up. |

## Data

Table `follow_ups`: `id`, `contact`, `send_at` (epoch ms), `message`, `status` (`SCHEDULED`, `SENT`, `CANCELLED`), `updated_at`.

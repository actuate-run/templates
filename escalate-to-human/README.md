# escalate-to-human

An MCP tool for "I don't know; let me ask a person". It opens a ticket, notifies a human, waits for their answer, and hands it back to the agent, or tells the agent nobody answered so it can say so honestly instead of guessing.

```
create ticket → notify human → wait for answer.<ticket> ─┬─ answer → ANSWERED + answer
                                                        └─ timeout → TIMED_OUT
```

```sh
npm create actuate my-bot -- --template escalate-to-human
cd my-bot && npm install && npx actuate dev
```

## Configuration

| Key | Default | What it does |
| --- | --- | --- |
| `humanContact` | required | Chat ID or email of the person or team chat that answers. |
| `answerTimeout` | `"4 hours"` | How long to wait: `15 minutes`, `1 hour`, `4 hours` or `24 hours`. |

Capability: `messaging`.

## How an agent uses this

```json
{ "method": "tools/call", "params": { "name": "escalate_to_human", "arguments": {
  "question": "Can Aina change her delivery address after dispatch?",
  "customerName": "Aina", "context": "Order A1, shipped this morning", "urgency": "urgent" } } }
```

The call returns `WAITING` with a `runId` (the ticket ID). The agent tells the customer it is checking, then polls `actuate_get_run`:

```json
{ "status": "ANSWERED", "ticketId": "run_019a...", "answer": "Yes, until 5pm today.", "answeredBy": "Farid" }
```

or `{ "status": "TIMED_OUT", "ticketId": "run_019a..." }`, in which case the agent should say a person will follow up.

## Events it waits for

| Event | Sent by | Effect |
| --- | --- | --- |
| `answer.<runId>` with `{"answer": "...", "by": "..."}` | The human, through whatever is easiest for your team: the dashboard, a small form, or a bot that turns their chat reply into this event | Returns the answer to the agent. A payload without a non-empty `answer` is not relayed. |

Locally: `curl -X POST localhost:8787/events/answer.<runId> -H 'content-type: application/json' -d '{"answer":"Yes, until 5pm today.","by":"Farid"}'`. Deployed, `/events/*` needs your `ACTUATE_TOKEN`.

## Data

Table `tickets`: `id`, `question`, `customer_name`, `context`, `urgency`, `status` (`OPEN`, `ANSWERED`, `TIMED_OUT`), `answer`, `answered_by`, `created_at`, `closed_at`.

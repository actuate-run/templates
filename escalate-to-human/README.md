# escalate-to-human

An MCP tool for "I don't know; let me ask a person". It opens a ticket, sends a human a signed link to a short answer form, waits for their answer, and hands it back to the agent, or tells the agent nobody answered so it can say so honestly instead of guessing.

```
create ticket → waitForInput("human-answer"): link to a text form ─┬─ answer → ANSWERED + answer
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

Capability: `messaging`, which delivers the answer link (Telegram, WhatsApp or email).

## How an agent uses this

```json
{ "method": "tools/call", "params": { "name": "escalate_to_human", "arguments": {
  "question": "Can Aina change her delivery address after dispatch?",
  "customerName": "Aina", "context": "Order A1, shipped this morning", "urgency": "urgent" } } }
```

The call returns `WAITING` with a `runId` (the ticket ID). The agent tells the customer it is checking, then polls `actuate_get_run`:

```json
{ "status": "ANSWERED", "ticketId": "run_019a...", "answer": "Yes, until 5pm today.", "answeredAt": "2026-11-02T03:12:40.000Z" }
```

or `{ "status": "TIMED_OUT", "ticketId": "run_019a..." }`, in which case the agent should say a person will follow up.

The tool is annotated `openWorld` (it messages a person) and not `idempotent`: every call opens a new ticket.

## What it waits for

| Wait | Resolved by | Timeout |
| --- | --- | --- |
| `human-answer` | The person in `humanContact` opening the signed link they receive and submitting the form (up to 2,000 characters; blank answers are refused). The link is single-use. | `answerTimeout` → TIMED_OUT |

Locally, `actuate dev` prints the link instead of sending it; open it in a browser to answer. Open requests also show in the dashboard's approval queue.

## Data

Table `tickets`: `id`, `question`, `customer_name`, `context`, `urgency`, `status` (`OPEN`, `ANSWERED`, `TIMED_OUT`), `answer`, `created_at`, `closed_at`.

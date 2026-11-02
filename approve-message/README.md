# approve-message

An MCP tool that puts a person between the agent and the customer. The agent drafts a message; a reviewer approves it, edits it, or rejects it; only then is anything sent. Nothing reaches the customer unapproved, and the result tells the agent exactly what was sent.

```
save draft → waitForApproval("human-review") ─┬─ approved, no note → send draft → SENT
                                              ├─ approved with note → send the note instead → SENT (edited)
                                              ├─ rejected → REJECTED (+ reviewer's note)
                                              └─ timeout → EXPIRED
```

```sh
npm create actuate my-bot -- --template approve-message
cd my-bot && npm install && npx actuate dev
```

## Configuration

| Key | Default | What it does |
| --- | --- | --- |
| `approver` | required | Chat ID or email that receives each draft and the signed approve / reject links. |
| `approvalTimeout` | `"4 hours"` | After this an undecided draft EXPIRES unsent: `1 hour`, `4 hours` or `24 hours`. |

Capability: `messaging`, both for the review request and the final message.

## How an agent uses this

```json
{ "method": "tools/call", "params": { "name": "approve_message", "arguments": {
  "to": "aina@example.com", "subject": "About your order",
  "draft": "Sorry about the delay. Here is 20% off your next order.",
  "context": "Late delivery, order 2291" } } }
```

The call returns `WAITING` with a `runId`. After the reviewer decides, `actuate_get_run` returns:

```json
{ "status": "SENT", "messageId": "run_019a...", "sentText": "Sorry about the delay. Here is 10% off your next order.", "edited": true }
```

or `{ "status": "REJECTED", "reviewerNote": "We don't discount for this", ... }`, which the agent can use to redraft.

## What it waits for

| Wait | Resolved by | Timeout |
| --- | --- | --- |
| `human-review` | The signed approve / reject links (send as is), or the dashboard's approval queue, where a note can be added. Approving **with a note sends the note instead of the draft**; rejecting with a note passes it back to the agent. | `approvalTimeout` → EXPIRED |

Over the API: `POST /runs/<runId>/approvals/human-review/approve` with `{"note": "edited text"}`.

## Data

Table `outgoing_messages`: `id`, `recipient`, `draft`, `sent_text`, `status` (`PENDING`, `SENT`, `REJECTED`, `EXPIRED`), `reviewer_note`, `created_at`, `decided_at`. A full record of what the agent wanted to say and what was actually said.

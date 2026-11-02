# support-escalation

AI support triage with a refund approval gate. An LLM reads the customer's message and decides *what kind* of message it is and how much refund it thinks is fair. The actuator decides *what happens*: answers go out directly, complaints go to your team, and refunds are capped in code, need a manager's approval above a threshold, and are written to an audit table.

```
classify with LLM ─┬─ question  → send the model's answer
                   ├─ complaint / other / unparseable → escalate to team, acknowledge customer
                   └─ refund → amount = min(model's amount, order amount, maxRefund)
                                 ├─ ≤ approvalThreshold → refund
                                 └─ > approvalThreshold → wait for approval ─┬─ approved → refund
                                                                             └─ rejected / timeout → tell customer
```

The model can never raise the cap: `maxRefund` and the order amount bound every refund, and the approval link shows the amount that will actually be paid.

```sh
npm create actuate my-bot -- --template support-escalation
cd my-bot && npm install && npx actuate dev
```

## Configuration

| Key | Default | What it does |
| --- | --- | --- |
| `businessName` | `"Kedai Kopi Aina"` | Used in the LLM's system prompt. |
| `currency` | `"MYR"` | Shown in messages and the approval request. |
| `approvalThreshold` | `50` | Refunds up to this amount are issued without a human. |
| `maxRefund` | `500` | Hard ceiling on any refund. |
| `approver` | required | Chat ID or email that receives the signed approve / reject links. |
| `supportTeam` | required | Chat ID or email that receives escalated tickets. |
| `approvalTimeout` | `"24 hours"` | After this, an unanswered approval counts as declined: `4 hours`, `24 hours` or `3 days`. |

Capabilities: `llm` (Anthropic, OpenAI or Google with your key), `messaging`, and `payment`. If your payment provider does not support refunds, approved refunds are recorded as `manual` and the customer is told your team will process them.

## Triggering a run

One run per incoming message, from your helpdesk webhook, chat bot, or an AI agent calling the MCP tool:

```sh
curl -X POST localhost:8787/run -H 'content-type: application/json' -d '{
  "ticketId": "T-1042",
  "customerName": "Aina",
  "contact": "123456789",
  "message": "My order arrived broken, can I get a refund?",
  "billId": "bill_abc123",
  "orderAmount": 120
}'
```

Without `billId` (or with `orderAmount` 0), refund requests are escalated instead of refunded.

## What it waits for

| Wait | Resolved by | Timeout |
| --- | --- | --- |
| `manager-approval` | The approver clicking the signed approve or reject link sent to `approver`, or the dashboard's approval queue. | `approvalTimeout` (counts as declined) |

## Data

Table `decisions` is the audit log: one row per classification, escalation, approval decision and refund, with `ticket_id`, `run_id`, `decision`, `amount`, `detail` and `at`. Export it as CSV from the dashboard.

# refund-order

An MCP tool that lets a support agent refund an order without being trusted with the money. The model decides *that* a refund is warranted; this actuator decides *how much* and *whether a person must agree*, in code the model cannot change.

```
check-previous ─ already refunded? → ALREADY_REFUNDED
amount = min(requested, maxRefund)
amount > approvalThreshold → waitForApproval("manager") ─┬─ approved → refund → audit → REFUNDED
                                                         └─ rejected / expired → audit → DECLINED
amount ≤ approvalThreshold → refund (idempotency key) → audit → REFUNDED
```

Why not let the model call the payment API directly? Because the cap, the approval gate, the once-per-order rule and the audit row are all enforced here, and a retried tool call reuses the step's idempotency key, so the payment provider never refunds twice.

```sh
npm create actuate my-bot -- --template refund-order
cd my-bot && npm install && npx actuate dev
```

## Configuration

| Key | Default | What it does |
| --- | --- | --- |
| `currency` | `"MYR"` | Shown to the approver. |
| `approvalThreshold` | `50` | Refunds above this wait for a manager. |
| `maxRefund` | `500` | Hard ceiling; larger requests are cut to this. |
| `approver` | `"@shop_manager"` | Chat ID or email that receives the signed approve / reject links. |
| `approvalTimeout` | `"24 hours"` | After this an undecided refund is DECLINED: `1 hour`, `24 hours` or `3 days`. |

Capabilities: `payment` (a provider that supports refunds, such as Stripe or Chip) and `messaging` (delivers the approval link). Locally, `actuate dev`'s fake payment provider prints each refund and always succeeds; to try a real provider, put Stripe test keys in `.dev.vars` (see `.env.example`).

## How an agent uses this

Connect your agent to the actuator's MCP endpoint and it sees a `refund_order` tool whose input schema is `orderId`, `billId`, `amount` and an optional `reason`.

```json
{ "method": "tools/call", "params": { "name": "refund_order", "arguments": { "orderId": "2291", "billId": "pi_3Q...", "amount": 120, "reason": "Arrived broken" } } }
```

At or below the threshold the call completes at once, with `structuredContent`:

```json
{ "status": "REFUNDED", "orderId": "2291", "amount": 40, "refundId": "re_3Q..." }
```

Above it, the tool returns a receipt with status `WAITING` and a `runId`; the agent tells the customer a manager is reviewing and later calls `actuate_get_run` with that `runId`:

```json
{ "status": "DECLINED", "orderId": "2291", "note": "Ask for a photo first" }
```

Send an `Idempotency-Key` with the call (MCP clients that retry do) and a retried call returns the first run's result instead of starting another.

The tool is annotated `destructive` and `openWorld` (it moves money), so MCP clients that ask a person before such calls will. It is not marked `idempotent`; the once-per-order check is a safeguard, not a promise.

## What it waits for

| Wait | Resolved by | Timeout |
| --- | --- | --- |
| `manager` | The approver clicking the signed link, or approving / rejecting from the dashboard (a note is passed back to the agent). | `approvalTimeout` → DECLINED |

## Data

Table `refunds`: `order_id`, `run_id`, `amount`, `status` (`REFUNDED` or `DECLINED`), `refund_id`, `note`, `at`. It is both the audit log and the once-per-order check.

The landing page's "Refunds" flow is an excerpt of this file. For a version where an LLM also triages the customer's message, see [`support-escalation`](../support-escalation).

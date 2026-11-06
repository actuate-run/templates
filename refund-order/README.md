# refund-order

An MCP tool that lets a support agent refund an order without being trusted with the money. The model decides *that* a refund is warranted; this actuator decides *how much* and *whether a person must agree*, in code the model cannot change.

```
same orderId as a run still going, or one completed in the last 24 hours → that run, nothing new starts
amount = min(requested, maxRefund)
claim-order ─ already refunded? → ALREADY_REFUNDED
            ─ another run is handling this order? → IN_PROGRESS
            ─ otherwise: a PENDING row claims the order
amount > approvalThreshold → waitForApproval("manager") ─┬─ approved → refund + audit → REFUNDED
                                                         └─ rejected / expired → audit → DECLINED
amount ≤ approvalThreshold → refund + audit → REFUNDED
refund fails for good → audit → FAILED (the order can be tried again)
```

Why not let the model call the payment API directly? Because the cap, the approval gate, the once-per-order rule and the audit row are all enforced here. A retried refund step sends the same idempotency key (the runtime derives it from the step), so a provider that honours it, such as Stripe, never refunds twice. The audit row is written with `ctx.db.commitWithStep`, in the same transaction that records the refund step as done, so the once-per-order check never misses a refund that went through.

The actuator declares `idempotencyKey: ["orderId"]`. A call that sends no idempotency key of its own gets one made from the order ID, so a retried or rephrased call for the same order returns the run already handling it: one that is still running or waiting for the manager, or one that completed in the last 24 hours. A failed or cancelled run never matches, so the order can be tried again. The key is made from `orderId` exactly as the agent sends it.

The order is still claimed before the approval wait, not after it, because the key doesn't cover every case: a call with its own explicit idempotency key is matched on that key alone, and a cancelled run frees the key. Two runs that both checked before waiting could both be approved and both refund. The claim is a `PENDING` row written in a step that does only database work, so no other run can claim the same order in between, and a second run returns `IN_PROGRESS` without asking the manager again. A claim older than the approval timeout plus an hour is treated as stale, so a run cancelled while it waited doesn't block the order forever. A refund that fails for good marks the claim `FAILED`, so the order can be tried again.

```sh
npm create actuate my-bot -- --template refund-order
cd my-bot && npm install && npx actuate dev
npx actuate test   # actuator.test.ts: fake providers and a test clock, no setup
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

Calling the tool again for the same order returns the same run (see above), whether or not the client sends an idempotency key. A client that does send one (an `Idempotency-Key` header, or `_meta["run.actuate/idempotencyKey"]` over MCP) is matched on that key alone, at any status; sending a new key is how you force a new run, which the once-per-order check then refuses if the order was already refunded.

The tool is annotated `destructive` and `openWorld` (it moves money), so MCP clients that ask a person before such calls will. The declared key also marks it `idempotent`: calling it twice with the same order has no further effect.

## What it waits for

| Wait | Resolved by | Timeout |
| --- | --- | --- |
| `manager` | The approver clicking the signed link, or approving / rejecting from the dashboard (a note is passed back to the agent). | `approvalTimeout` → DECLINED |

## Data

Table `refunds`: `order_id`, `run_id`, `amount`, `status` (`PENDING` while a run holds the order, then `REFUNDED`, `DECLINED` or `FAILED`), `refund_id`, `note`, `at`. It is both the audit log and the once-per-order check.

The landing page's "Refunds" flow is an excerpt of this file. For a version where an LLM also triages the customer's message, see [`support-escalation`](../support-escalation).

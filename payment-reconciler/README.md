# payment-reconciler

Turns payment webhooks into a clean `payments` table in SQLite and checks every paid bill against what you expected to be paid. Webhooks are recorded exactly once however often the provider retries, and amount or currency mismatches (or payments nobody expected) trigger an alert.

```
expect {referenceId, amount}  → expected_payments
payment webhook → reconcile against expected_payments → upsert payments → alert on mismatch (first time only)
```

```sh
npm create actuate my-bot -- --template payment-reconciler
cd my-bot && npm install && npx actuate dev
```

## Configuration

| Key | Default | What it does |
| --- | --- | --- |
| `alertTo` | `""` | Chat ID, phone or email to alert on a mismatch. Empty records mismatches without alerting. |
| `amountTolerance` | `0` | Slack, in major units, before an amount difference counts as a mismatch. |

Capability: `messaging`, for alerts. If you never want alerts, you can remove `"messaging"` from `capabilities` and the `alert-mismatch` step.

## Triggering a run

The input is one of two shapes.

**A payment webhook**, normalised to these fields (Stripe, Chip, ToyyibPay and Billplz all carry them):

```sh
curl -X POST localhost:8787/run -H 'content-type: application/json' -d '{
  "provider": "chip",
  "billId": "bill_abc123",
  "referenceId": "order-42",
  "amount": 50,
  "currency": "MYR",
  "status": "paid",
  "paidAt": "2026-11-02T09:15:00+08:00"
}'
```

`status` is one of `pending`, `paid`, `failed`, `expired`, `refunded`. Point your provider (or a small forwarder that normalises its payload) at the actuator's `/webhook` URL with your `x-actuate-secret` header.

**An expected payment**, registered when you issue an invoice or create an order:

```sh
curl -X POST localhost:8787/run -H 'content-type: application/json' -d '{
  "expect": { "referenceId": "order-42", "amount": 50, "currency": "MYR" }
}'
```

This actuator does not wait for events; each run finishes immediately.

## Data

- `expected_payments`: `reference_id`, `amount`, `currency`, `created_at`.
- `payments`: one row per `(provider, bill_id)` with `reference_id`, `amount`, `currency`, `status`, `paid_at`, `updated_at` and `verdict`: `matched`, `amount_mismatch`, `currency_mismatch`, `unexpected` (no expected payment for that reference), or `not_paid`.

A redelivered webhook identical to the stored row is reported as `duplicate: true` and does not alert again. A status change (for example `paid` → `refunded`) updates the row and keeps the original `paid_at`.

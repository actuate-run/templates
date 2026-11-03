# order-status

A read-only MCP tool that answers "where is my order?" from the actuator's own SQLite `orders` table. It shows the safe way to give an agent access to state: fixed, parameterised queries, a required customer email so one customer can't see another's orders, and no way for the agent to write.

```
MCP call {email, orderId?} → SELECT ... WHERE email = ? [AND order_id = ?] → orders
shop webhook {order: {...}} → upsert into orders          (refused unless it arrives by webhook)
```

```sh
npm create actuate my-bot -- --template order-status
cd my-bot && npm install && npx actuate dev
npx actuate test   # actuator.test.ts: fake providers and a test clock, no setup
```

## Configuration

| Key | Default | What it does |
| --- | --- | --- |
| `maxResults` | `5` | How many recent orders a lookup by email returns. |

No capabilities: it never calls out.

## Getting orders in

Point your shop's order webhook (or a small forwarder) at the actuator's `/webhook` URL, with your `x-actuate-secret` header, whenever an order is created or changes:

```sh
curl -X POST 'localhost:8787/webhook' -H 'content-type: application/json' -d '{
  "order": {
    "orderId": "A1", "email": "aina@example.com", "status": "shipped", "total": 42.5,
    "currency": "MYR", "items": "2x Kopi O beans 250g", "trackingUrl": "https://track.example/A1"
  }
}'
```

`status` is one of `pending`, `paid`, `packed`, `shipped`, `delivered`, `cancelled`, `refunded`. The same input sent through MCP or `/run` is ignored (`recorded: false`): only the `webhook` trigger may write.

## How an agent uses this

```json
{ "method": "tools/call", "params": { "name": "order_status", "arguments": { "email": "aina@example.com", "orderId": "A1" } } }
```

It always completes immediately, with `structuredContent`:

```json
{
  "found": true,
  "recorded": false,
  "orders": [
    { "orderId": "A1", "status": "shipped", "total": 42.5, "currency": "MYR", "items": "2x Kopi O beans 250g",
      "trackingUrl": "https://track.example/A1", "updatedAt": "2026-11-02T09:00:00.000Z" }
  ]
}
```

Omit `orderId` to get the customer's most recent orders. A wrong email returns `found: false`, exactly like a missing order, so the agent can't probe for other customers' orders.

This actuator does not wait for events.

The tool is annotated `readOnly` and `idempotent`, so clients can call it without asking.

## Data

Table `orders`: `order_id`, `email` (lower-cased), `status`, `total`, `currency`, `items`, `tracking_url`, `updated_at`.

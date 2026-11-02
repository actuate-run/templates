# deposit-reminder

A booking bot for clinics, salons and studios. It holds an appointment, sends the customer a deposit payment link, reminds them if they have not paid, confirms once the payment webhook arrives, and messages them again the day before the appointment.

```
save booking → send payment link → wait for payment (reminderDelay)
                                       ├─ paid → confirm → sleep until 24 h before → "see you tomorrow"
                                       └─ not yet → reminder → wait (holdAfterReminder)
                                                                 ├─ paid → confirm → …
                                                                 └─ not paid → release slot
```

While it waits, the run hibernates and costs nothing, whether that is two hours or two weeks.

```sh
npm create actuate my-bot -- --template deposit-reminder
cd my-bot && npm install && npx actuate dev
```

## Configuration

Set in `actuate.config.json` locally, or in the dashboard once deployed.

| Key | Default | What it does |
| --- | --- | --- |
| `businessName` | `"Klinik Pergigian Senyum"` | Shown in every message and on the bill. |
| `depositAmount` | `50` | Deposit in major units (RM 50.00). 1 to 10,000. |
| `currency` | `"MYR"` | ISO 4217 code passed to the payment provider. |
| `reminderDelay` | `"2 hours"` | How long to wait for payment before sending a reminder: `30 minutes`, `2 hours` or `24 hours`. |
| `holdAfterReminder` | `"24 hours"` | How much longer the slot is held after the reminder before it is released. |
| `timeZone` | `"Asia/Kuala_Lumpur"` | Used to format the appointment time in messages. |

Capabilities: `payment` (Stripe, Chip, ToyyibPay or Billplz) and `messaging` (Telegram or WhatsApp). Credentials are listed in `.env.example`.

## Triggering a run

Each booking is one run. Post it from your booking form, a chatbot, or an AI agent through the actuator's MCP tool:

```sh
curl -X POST localhost:8787/run -H 'content-type: application/json' -d '{
  "customerName": "Aina",
  "contact": "+60123456789",
  "appointmentIso": "2026-11-20T10:00:00+08:00"
}'
```

`contact` is a phone number for WhatsApp or a chat ID for Telegram. Once deployed, send the same JSON to the actuator's `/webhook` URL with your `x-actuate-secret` header.

## Events it waits for

| Event | Sent by | Effect |
| --- | --- | --- |
| `payment.<runId>` | Your payment provider's webhook as a `PaymentEvent`. The bill's `referenceId` is the run ID. | `status: "paid"` confirms the booking; anything else counts as not paid yet. |

Locally, `actuate dev` prints the payment link; opening it posts the `payment.<runId>` event, so you can click your way through the happy path. To test the reminder path, wait for `reminderDelay` or set it to `30 minutes`.

## Data

Table `bookings`: `id`, `customer_name`, `contact`, `appointment_at`, `status` (`PENDING`, `CONFIRMED`, `EXPIRED`), `bill_id`, `updated_at`. Browse or export it from the dashboard.

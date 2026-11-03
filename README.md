# templates

First-party [Actuate](https://actuate.run) actuator templates: hosted, durable TypeScript scripts with a built-in SQLite database and MCP endpoint. Each folder is one template, fetched by name:

```sh
npm create actuate my-bot -- --template <name>
cd my-bot && npm install && npx actuate dev
npx actuate test   # the template's own actuator.test.ts
```

## Agent tools

Small, MCP-first tools an AI agent calls. Each one is the deterministic half of an agent: the model decides *what* should happen, and the actuator decides *how*, with caps, approvals, validation and an audit trail the model cannot change. Every tool has an `output` schema, so MCP clients get `structuredContent`, and MCP `hints` (read-only, destructive, open-world) so clients know which calls need a person's OK.

| Template | Tool | What it does | Leans on |
| --- | --- | --- | --- |
| [`refund-order`](refund-order) | `refund_order` | Refunds an order: amount capped in code, manager approval above a threshold, once per order, audit row. | `waitForApproval`, `commitWithStep` |
| [`lead-intake`](lead-intake) | `lead_intake` | Saves a lead, emails day 1 and day 3, stops when they reply; REPLIED or COLD. | `waitForEvent` |
| [`order-status`](order-status) | `order_status` | Read-only order lookup over the actuator's own SQLite, scoped to the customer's email. | parameterised `ctx.db` |
| [`schedule-follow-up`](schedule-follow-up) | `schedule_follow_up` | Sends a message at a validated future time unless the customer replies first. | `waitForEvent({ until })` |
| [`approve-message`](approve-message) | `approve_message` | A person approves, edits or rejects the agent's draft before anything is sent. | `waitForApproval` |
| [`escalate-to-human`](escalate-to-human) | `escalate_to_human` | Opens a ticket, asks a person, and returns their answer (or a clear timeout). | `waitForInput` |

## Automations

Webhook- and cron-driven actuators that replace a script you would otherwise run somewhere worse.

| Template | What it does | Capabilities | Leans on |
| --- | --- | --- | --- |
| [`deposit-reminder`](deposit-reminder) | Holds a booking, sends a deposit payment link, reminds if unpaid, confirms on payment, reminds the day before the appointment. | payment, messaging | `waitForEvent`, `sleepUntil` |
| [`support-escalation`](support-escalation) | LLM triage of support messages; refunds capped in code, with a human approval gate above a threshold and an audit table. | llm, messaging, payment | `waitForApproval` |
| [`payment-reconciler`](payment-reconciler) | Records payment webhooks exactly once in SQLite and flags amounts that don't match what was expected. | messaging (optional) | idempotent `step.do` |
| [`github-release-telegram`](github-release-telegram) | Posts a formatted Telegram message when a GitHub release is published. | messaging | webhooks |
| [`daily-report`](daily-report) | Collects events during the day and sends a 09:00 MYT summary. | messaging | `cron` |

Every template folder has:

- `actuator.ts`: the actuator, one file.
- `actuator.test.ts`: a short test of its main path and one edge case, written with `@actuate/cli/testing` and `node:test`. `npm create actuate` copies it into the new project, where `npx actuate test` runs it.
- `README.md`: what it does, its configuration, how to trigger it, and what it waits for.
- `.env.example`: provider settings, generated from `@actuate/providers` (`pnpm env-examples`). Copy to `.dev.vars` and uncomment to use real providers locally.
- `actuate.config.json`: example configuration, used by `actuate dev` and `actuate deploy`.

## Developing the templates

```sh
pnpm install
pnpm typecheck   # tsc over every actuator.ts and the tests
pnpm test        # actuate test: every actuator.test.ts (node:test) and test/*.test.ts (Vitest)
pnpm check       # actuate check --platform --plan maker in every template folder
```

Every test uses `testActuator` from `@actuate/cli/testing`: the real step engine on in-memory SQLite, recording fakes for every provider, a test clock (`t.advance` fires every sleep, timeout and retry on the way), signed approval and answer links, and the hosted platform's guards for a plan (Sandbox by default; tests that wait longer than 7 days pass `plan: "maker"`). Each template's `actuator.test.ts` is the short one new projects get; `test/<template>.test.ts` covers the rest: timeouts, rejections, retries and their idempotency keys, caps and webhook redelivery. `test/check.test.ts` also asserts that every template passes `actuate check` with no errors or warnings, stays readable (50 to 130 lines for an agent tool, 60 to 150 for an automation), ships a config its schema accepts, and ships an `actuator.test.ts` that runs in a new project; agent tools must also declare an object `output` schema. `pnpm check` uses `--plan maker` because the Sandbox plan has no messaging, payment or LLM providers.

## Contributing a template

Keep it to one readable `actuator.ts` (50 to 130 lines for an agent tool, 60 to 150 for an automation): well-named steps, every side effect inside `ctx.step.do`, comments only where they explain why. Add an `actuator.test.ts` next to it (only `node:test` and `@actuate/cli/testing`, at most 40 lines: it ships to new projects, which have no Vitest), put the thorough tests in `test/<template>.test.ts`, and make sure `pnpm typecheck && pnpm test && pnpm check` pass.

## License

MIT. See [LICENSE](LICENSE).

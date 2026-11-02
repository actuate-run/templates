# templates

First-party [Actuate](https://actuate.run) actuator templates: hosted, durable TypeScript scripts with a built-in SQLite database and MCP endpoint. Each folder is one template, fetched by name:

```sh
npm create actuate my-bot -- --template <name>
cd my-bot && npm install && npx actuate dev
```

## Agent tools

Small, MCP-first tools an AI agent calls. Each one is the deterministic half of an agent: the model decides *what* should happen, and the actuator decides *how*, with caps, approvals, validation and an audit trail the model cannot change. Every tool has an `output` schema, so MCP clients get `structuredContent`, and MCP `hints` (read-only, destructive, open-world) so clients know which calls need a person's OK.

| Template | Tool | What it does | Leans on |
| --- | --- | --- | --- |
| [`refund-order`](refund-order) | `refund_order` | Refunds an order: amount capped in code, manager approval above a threshold, once per order, audit row. | `waitForApproval`, idempotency key |
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
- `README.md`: what it does, its configuration, how to trigger it, and what it waits for.
- `.env.example`: provider settings, generated from `@actuate/providers` (`pnpm env-examples`). Copy to `.dev.vars` and uncomment to use real providers locally.
- `actuate.config.json`: example configuration, used by `actuate dev` and `actuate deploy`.

## Developing the templates

```sh
pnpm install
pnpm typecheck   # tsc over every actuator.ts and the tests
pnpm test        # runs each template on the in-memory runtime with fake providers and a fake clock
pnpm check       # actuate check (replay-safety lint) on every template
```

The tests in `test/` drive each actuator through `@actuate/runtime`'s `RunManager` with in-memory SQLite, recording fake providers and a fake clock, covering happy paths, timeouts, approvals and webhook redelivery. `test/check.test.ts` also asserts that every template passes `actuate check` with no errors or warnings, stays readable (50 to 130 lines for an agent tool, 60 to 150 for an automation), and ships a config its schema accepts; agent tools must also declare an object `output` schema.

> **Note:** `@actuate/sdk`, `@actuate/runtime` and `@actuate/cli` are not yet published to npm, so `package.json` links them from a sibling checkout of [`actuate-run/actuate`](https://github.com/actuate-run/actuate) (`link:../actuate/packages/*`, with `pnpm -r build` run there first). They become normal semver ranges once the packages publish.

## Contributing a template

Keep it to one readable `actuator.ts` (50 to 130 lines for an agent tool, 60 to 150 for an automation): well-named steps, every side effect inside `ctx.step.do`, comments only where they explain why. Add a test file in `test/` and make sure `pnpm typecheck && pnpm test` pass.

## License

MIT. See [LICENSE](LICENSE).

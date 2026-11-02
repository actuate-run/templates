import { defineActuator, z } from "@actuate/sdk";

export const ConfigSchema = z.object({
  // How many recent orders a lookup by email returns.
  maxResults: z.number().int().min(1).max(20).default(5),
});

const Order = z.object({
  orderId: z.string().min(1),
  email: z.email().transform((e) => e.toLowerCase()),
  status: z.enum(["pending", "paid", "packed", "shipped", "delivered", "cancelled", "refunded"]),
  total: z.number().min(0),
  currency: z.string().length(3).default("MYR"),
  items: z.string().max(1000).describe("Human-readable summary, e.g. '2x Kopi O beans 250g'"),
  trackingUrl: z.url().nullable().default(null),
});

/** What an agent sends. The customer's email is always required, so one customer can't read another's order. */
const Lookup = z.object({
  email: z.email().transform((e) => e.toLowerCase()).describe("The customer's email address"),
  orderId: z.string().min(1).optional().describe("A specific order; omit to list the customer's recent orders"),
});

/** What your shop's webhook sends when an order is created or changes. Ignored unless it arrives by webhook. */
const Upsert = z.object({ order: Order });

export const InputSchema = z.union([Lookup, Upsert]);

export const OutputSchema = z.object({
  found: z.boolean(),
  orders: z.array(Order.omit({ email: true }).extend({ updatedAt: z.string() })),
  recorded: z.boolean().describe("True only for a webhook that saved an order"),
});

type OrderRow = z.output<typeof OutputSchema>["orders"][number];
const COLUMNS = `order_id AS orderId, status, total, currency, items, tracking_url AS trackingUrl, updated_at AS updatedAt`;

export default defineActuator({
  name: "order_status",
  description:
    "Look up a customer's orders: status, items, total and tracking link. Read-only and safe to call as often as needed. " +
    "Always pass the customer's email; add orderId for one order, or omit it for their most recent orders. " +
    "Returns found=false when nothing matches that email, so never guess an order for a different email.",
  config: ConfigSchema,
  input: InputSchema,
  output: OutputSchema,
  async run(ctx, input, config): Promise<z.output<typeof OutputSchema>> {
    await ctx.db.migrate([
      `CREATE TABLE orders (order_id TEXT PRIMARY KEY, email TEXT NOT NULL, status TEXT NOT NULL, total REAL NOT NULL,
         currency TEXT NOT NULL, items TEXT NOT NULL, tracking_url TEXT, updated_at TEXT NOT NULL)`,
      `CREATE INDEX orders_email ON orders (email, updated_at)`,
    ]);

    if ("order" in input) {
      // Writes come only from your shop's webhook. The same input over MCP is refused, so an agent can never edit an order.
      if (ctx.trigger.kind !== "webhook") return { found: false, orders: [], recorded: false };
      const o = input.order;
      await ctx.step.do("save-order", ({ now }) =>
        ctx.db.sql`INSERT INTO orders VALUES (${o.orderId}, ${o.email}, ${o.status}, ${o.total}, ${o.currency}, ${o.items},
          ${o.trackingUrl}, ${new Date(now).toISOString()})
          ON CONFLICT (order_id) DO UPDATE SET email = excluded.email, status = excluded.status, total = excluded.total,
            currency = excluded.currency, items = excluded.items, tracking_url = excluded.tracking_url, updated_at = excluded.updated_at`,
      );
      return { found: false, orders: [], recorded: true };
    }

    // Parameterised SELECTs only: the agent's input is always a bound value, never SQL.
    const orders = input.orderId
      ? await ctx.db.query<OrderRow>(`SELECT ${COLUMNS} FROM orders WHERE order_id = ? AND email = ?`, [input.orderId, input.email])
      : await ctx.db.query<OrderRow>(`SELECT ${COLUMNS} FROM orders WHERE email = ? ORDER BY updated_at DESC LIMIT ?`, [
          input.email,
          config.maxResults,
        ]);
    return { found: orders.length > 0, orders, recorded: false };
  },
});

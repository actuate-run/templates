// Regenerate every template's .env.example from @actuate/providers, so variable
// names always match what `actuate dev` and self-hosted runtimes read.
// Run: pnpm env-examples
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROVIDERS, envVarsFor } from "@actuate/providers";

/** The provider each template uses by default for each capability. */
const DEFAULTS = { messaging: "telegram", payment: "billplz", llm: "anthropic" };
/** Per-template overrides (e.g. Stripe for support refunds, since it supports them). */
const OVERRIDES = {
  "support-escalation": { payment: "stripe" },
  "refund-order": { payment: "stripe" },
  "lead-intake": { messaging: "resend" },
};

const root = new URL("..", import.meta.url).pathname;
for (const name of readdirSync(root)) {
  const file = join(root, name, "actuator.ts");
  try {
    statSync(file);
  } catch {
    continue;
  }
  const source = readFileSync(file, "utf8");
  // Required and optional capabilities both need settings to be used.
  const declared = [...source.matchAll(/apabilities:\s*\[([^\]]*)\]/g)].map((m) => m[1]).join(",");
  const caps = ["messaging", "payment", "llm"].filter((c) => declared.includes(`"${c}"`));
  const lines = [
    `# Provider settings for ${name}. Placeholders only: never commit real values.`,
    "# Locally, copy this to .dev.vars, then uncomment a provider and fill in its keys.",
    "# Anything left commented out stays local: `actuate dev` prints messages and fakes payments.",
    "# On the hosted platform, set providers in the dashboard (Settings → Providers) instead.",
    "# Every provider and its variables: npx actuate providers",
  ];
  for (const cap of caps) {
    const chosen = OVERRIDES[name]?.[cap] ?? DEFAULTS[cap];
    const others = Object.values(PROVIDERS).filter((p) => p.capability === cap && p.kind !== chosen).map((p) => p.kind);
    lines.push("", `# ${cap}: ${chosen} (or ${others.join(", ")})`, `# ACTUATE_${cap.toUpperCase()}=${chosen}`);
    // Optional settings are left out; `npx actuate providers` lists them.
    for (const v of envVarsFor(chosen).filter((v) => !v.optional)) lines.push(`# ${v.name}=`);
  }
  lines.push("", "# Runtime (self-hosted or `actuate dev` only)", "# ACTUATE_WEBHOOK_SECRET=", "");
  writeFileSync(join(root, name, ".env.example"), lines.join("\n"));
  console.log(`${name}: ${caps.join(", ") || "no providers"}`);
}

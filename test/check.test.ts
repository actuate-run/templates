import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSource } from "@actuate/cli";
import { z, type Actuator } from "@actuate/sdk";

const root = join(import.meta.dirname, "..");
/** MCP-first tools an agent calls; the landing page links these folder names. */
const AGENT_TOOLS = ["refund-order", "lead-intake", "order-status", "schedule-follow-up", "approve-message", "escalate-to-human"];
const AUTOMATIONS = ["deposit-reminder", "support-escalation", "payment-reconciler", "github-release-telegram", "daily-report"];
const templates = readdirSync(root).filter((d) => existsSync(join(root, d, "actuator.ts")));

describe("templates", () => {
  it("ships the six agent tools and the five automations", () => {
    expect(templates.sort()).toEqual([...AGENT_TOOLS, ...AUTOMATIONS].sort());
  });

  describe.each(templates)("%s", (name) => {
    const dir = join(root, name);
    const source = readFileSync(join(dir, "actuator.ts"), "utf8");

    it("passes the replay-safety linter with no errors or warnings", () => {
      expect(checkSource(`${name}/actuator.ts`, source)).toEqual([]);
    });

    it("has a README with the create command and an .env.example without secrets", () => {
      expect(readFileSync(join(dir, "README.md"), "utf8")).toContain(`npm create actuate my-bot -- --template ${name}`);
      const env = readFileSync(join(dir, ".env.example"), "utf8");
      for (const line of env.split("\n").filter((l) => /^[A-Z_]+=/.test(l))) {
        expect(line).toMatch(/=(|your-.*|<.*>)$/);
      }
    });

    const [min, max] = AGENT_TOOLS.includes(name) ? [50, 130] : [60, 150];
    it(`stays readable (${min}-${max} lines)`, () => {
      const lines = source.trimEnd().split("\n").length;
      expect(lines).toBeGreaterThanOrEqual(min);
      expect(lines).toBeLessThanOrEqual(max);
    });

    it("ships a short actuator.test.ts that runs as is in a project made by npm create actuate", () => {
      // create-actuate copies it next to actuator.ts, in a project with @actuate/sdk and @actuate/cli but no Vitest.
      const test = readFileSync(join(dir, "actuator.test.ts"), "utf8");
      const imports = [...test.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
      expect(imports).toEqual(expect.arrayContaining(["node:test", "@actuate/cli/testing", "./actuator.js"]));
      expect(imports.filter((i) => !["node:test", "node:assert/strict", "@actuate/cli/testing", "@actuate/sdk", "./actuator.js"].includes(i!))).toEqual([]);
      expect(test.trimEnd().split("\n").length).toBeLessThanOrEqual(40);
    });

    if (AGENT_TOOLS.includes(name)) {
      it("is an MCP-ready agent tool: object output schema and a model-facing description", async () => {
        const { default: actuator } = (await import(`../${name}/actuator.ts`)) as { default: Actuator };
        expect(actuator.output).toBeDefined();
        expect(z.toJSONSchema(actuator.output!, { io: "output" })).toMatchObject({ type: "object" });
        expect(actuator.description.length).toBeGreaterThan(150);
        expect(actuator.hints, "MCP tool hints").toBeDefined();
        expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("## How an agent uses this");
      });
    }

    it("has no hand-written regex with nested quantifiers (the deploy check rejects them)", async () => {
      const { default: actuator } = (await import(`../${name}/actuator.ts`)) as { default: Actuator };
      // Same rule as the platform's validatePatterns; zod's built-in formats (which carry `format`) are allowed.
      const NESTED = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)(?:[+*]|\{\d*,)/;
      const bad: string[] = [];
      const walk = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        const obj = node as Record<string, unknown>;
        if (typeof obj.pattern === "string" && !obj.format && NESTED.test(obj.pattern)) bad.push(obj.pattern);
        Object.values(obj).forEach(walk);
      };
      for (const schema of [actuator.input, actuator.config, actuator.output]) {
        if (schema) walk(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }));
      }
      expect(bad).toEqual([]);
    });

    it("ships an actuate.config.json that its ConfigSchema accepts", async () => {
      const { default: actuator } = (await import(`../${name}/actuator.ts`)) as { default: Actuator };
      const config = JSON.parse(readFileSync(join(dir, "actuate.config.json"), "utf8"));
      expect(actuator.config?.safeParse(config).success).toBe(true);
    });
  });
});

describe(".env.example files", () => {
  it("only name variables that @actuate/providers or the runtime actually read", async () => {
    const { PROVIDERS, envVarsFor } = await import("@actuate/providers");
    const known = new Set<string>(["ACTUATE_MESSAGING", "ACTUATE_PAYMENT", "ACTUATE_LLM", "ACTUATE_WEBHOOK_SECRET", "ACTUATE_TOKEN", "ACTUATE_CONFIG", "ACTUATE_APPROVAL_SECRET", "ACTUATE_PUBLIC_URL"]);
    for (const p of Object.values(PROVIDERS)) for (const v of envVarsFor(p.kind)) known.add(v.name);
    const { readdirSync, readFileSync, existsSync } = await import("node:fs");
    const root = new URL("..", import.meta.url).pathname;
    for (const name of readdirSync(root)) {
      const file = `${root}${name}/.env.example`;
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const m = /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(line);
        if (m) expect(known.has(m[1]!), `${name}: ${m[1]}`).toBe(true);
      }
    }
  });
});

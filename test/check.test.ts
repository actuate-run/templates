import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSource } from "@actuate/cli";
import type { Actuator } from "@actuate/sdk";

const root = join(import.meta.dirname, "..");
const templates = readdirSync(root).filter((d) => existsSync(join(root, d, "actuator.ts")));

describe("templates", () => {
  it("ships the five Stage 1 templates", () => {
    expect(templates.sort()).toEqual([
      "daily-report",
      "deposit-reminder",
      "github-release-telegram",
      "payment-reconciler",
      "support-escalation",
    ]);
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

    it("stays readable (60-150 lines)", () => {
      const lines = source.trimEnd().split("\n").length;
      expect(lines).toBeGreaterThanOrEqual(60);
      expect(lines).toBeLessThanOrEqual(150);
    });

    it("ships an actuate.config.json that its ConfigSchema accepts", async () => {
      const { default: actuator } = (await import(`../${name}/actuator.ts`)) as { default: Actuator };
      const config = JSON.parse(readFileSync(join(dir, "actuate.config.json"), "utf8"));
      expect(actuator.config?.safeParse(config).success).toBe(true);
    });
  });
});

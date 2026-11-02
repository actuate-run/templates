import { DatabaseSync } from "node:sqlite";
import { z, type Actuator, type Bill, type CreateBillRequest, type LlmRequest, type MessagingSendOptions, type Providers, type RefundRequest, type Trigger } from "@actuate/sdk";
import { vi } from "vitest";
import { RunManager, executePass, nodeSqlite, type ApprovalRequest } from "@actuate/runtime";

export const T0 = Date.parse("2026-11-02T00:00:00Z");
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export interface SentMessage {
  to: string;
  text: string;
  options?: MessagingSendOptions;
}

/** Recording fakes for every capability. LLM replies are served from a queue. */
export function fakeProviders(opts: { llmReplies?: string[]; refund?: boolean } = {}) {
  const sent: SentMessage[] = [];
  const bills: CreateBillRequest[] = [];
  const refunds: RefundRequest[] = [];
  const prompts: LlmRequest[] = [];
  const llmReplies = [...(opts.llmReplies ?? [])];
  const providers: Partial<Providers> = {
    messaging: {
      async send(to, text, options) {
        sent.push({ to, text, ...(options ? { options } : {}) });
        return { id: `msg-${sent.length}`, channel: options?.channel ?? "test" };
      },
    },
    payment: {
      async createBill(request): Promise<Bill> {
        bills.push(request);
        return {
          id: `bill-${bills.length}`,
          url: `https://pay.test/${request.referenceId}`,
          status: "pending",
          amount: request.amount,
          currency: request.currency ?? "MYR",
          referenceId: request.referenceId,
        };
      },
      async getBill() {
        throw new Error("not used");
      },
      ...(opts.refund === false
        ? {}
        : {
            async refund(request: RefundRequest) {
              refunds.push(request);
              return { id: `refund-${refunds.length}`, status: "succeeded" as const };
            },
          }),
    },
    llm: {
      async complete(request) {
        prompts.push(request);
        const text = llmReplies.shift();
        if (text === undefined) throw new Error("fake llm: no reply queued");
        return { text, model: "fake" };
      },
    },
  };
  return { providers, sent, bills, refunds, prompts };
}

/**
 * In-memory runtime with a fake clock, mirroring @actuate/runtime's own tests.
 * Inputs are validated with the actuator's schema, as the gateway does.
 * `Date` is faked too, so `Date.now()` inside a step agrees with the engine's clock.
 */
export function harness(actuator: Actuator, opts: { providers?: Partial<Providers>; config?: unknown } = {}) {
  let now = T0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const approvals: ApprovalRequest[] = [];
  const config = (actuator.config ?? z.object({})).parse(opts.config ?? {});
  const manager = new RunManager({
    sql: nodeSqlite(new DatabaseSync(":memory:")),
    approvalSecret: "test-secret",
    approvalUrl: "https://example.test/approve",
    now: () => now,
    consoleLogs: false,
    notifyApproval: async (r) => void approvals.push(r),
    invoke: (request, journal) =>
      executePass(actuator, request, { journal, config, ...(opts.providers ? { providers: opts.providers } : {}) }),
  });
  const run = (id: string) => manager.getRun(id)!;
  return {
    manager,
    approvals,
    now: () => now,
    run,
    advance: async (ms: number) => {
      now += ms;
      vi.setSystemTime(now);
      await manager.alarm();
    },
    start: async (input: unknown = {}, trigger: Trigger = { kind: "api" }) => {
      const { run: started } = await manager.start({ input: actuator.input.parse(input) as never, trigger });
      return started;
    },
    /** Approve or reject the most recent approval request through its signed link. */
    decide: (approve: boolean) => {
      const request = approvals.at(-1)!;
      const token = new URL(approve ? request.approveUrl : request.rejectUrl).searchParams.get("token")!;
      return manager.decide(token);
    },
    rows: (table: string) => manager.readTable(table).rows,
  };
}

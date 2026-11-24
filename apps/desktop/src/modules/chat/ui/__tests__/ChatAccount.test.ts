import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri-api", () => ({ getUsageSnapshot: async () => [] }));

import { ClaudeTranslator } from "../../providers/claude/translate";
import { nextAccount } from "../ChatAccount";
import type { UsageAccount } from "@/modules/workspace-shell/services/usage";
import type { ThreadEvent, ThreadEventEnvelope } from "../../domain/thread-event";
import { applyThreadEvents, emptyThreadState } from "../../domain/thread-state";

const stateOf = (events: ThreadEvent[]) =>
  applyThreadEvents(
    emptyThreadState("t"),
    events.map((event, i): ThreadEventEnvelope => ({ threadId: "t", seq: i + 1, at: 1000 + i, event })),
  );

const limitEvent = (status: string) => ({
  type: "rate_limit_event",
  rate_limit_info: { status, resetsAt: 1793604600, rateLimitType: "five_hour" },
});

describe("account switch", () => {
  it("keeps only a warning or a rejection from Claude's rate limit events", () => {
    const translator = new ClaudeTranslator();
    expect(translator.translate(limitEvent("allowed"))).toEqual([]);
    expect(translator.translate(limitEvent("rejected"))).toEqual([
      { type: "session/rateLimit", status: "rejected", rateLimitType: "five_hour", resetsAtMs: 1793604600000 },
    ]);
  });

  it("clears the limit when the thread moves to another account", () => {
    const limited = stateOf([{ type: "session/rateLimit", status: "rejected", rateLimitType: "five_hour", resetsAtMs: null }]);
    expect(limited.rateLimit?.status).toBe("rejected");
    const moved = stateOf([
      { type: "session/rateLimit", status: "rejected", rateLimitType: "five_hour", resetsAtMs: null },
      { type: "session/accountChanged", account: "acme" },
    ]);
    expect(moved.rateLimit).toBeNull();
    expect(moved.account).toBe("acme");
    expect(moved.modelSwitches.at(-1)?.label).toBe("acme account");
  });

  it("continues on the least-used other account that has room and a sign-in", () => {
    const acct = (account: string, used: number, error: string | null = null): UsageAccount => ({
      provider: "claude",
      account,
      plan: "team",
      inUse: false,
      windows: [{ kind: "session", group: "session", usedPercent: used, resetsAtMs: null, windowMinutes: 300 }],
      error,
    });
    const all = [acct("initech", 100), acct("globex", 40), acct("acme", 9), acct("stale", 0, "sign-in is stale")];
    expect(nextAccount(all, "initech")?.account).toBe("acme");
    expect(nextAccount([acct("initech", 100), acct("globex", 100)], "initech")).toBeNull();
  });
});

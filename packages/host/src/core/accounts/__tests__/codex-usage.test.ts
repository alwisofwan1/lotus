import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { codexLabel, codexUsage } from "../codex-usage.js";
import type { Account } from "../types.js";

const NOW = 1_800_000_000_000;
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lotus-cx-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const acct = (id: string): Account => ({ id, source: "default", dir, configFile: join(dir, "config.toml") });
const event = (limits: unknown): string => JSON.stringify({ payload: { rate_limits: limits } });

function session(name: string, lines: string[], mtimeSec: number): void {
  const d = join(dir, "sessions/2026/11");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), lines.join("\n"));
  utimesSync(join(d, name), mtimeSec, mtimeSec);
}

describe("codexUsage", () => {
  it("reads the newest snapshot, labels default ChatGPT, and zeroes a reset window", () => {
    session("old.jsonl", [event({ plan_type: "plus", primary: { used_percent: 1, window_minutes: 300, resets_at: NOW / 1000 + 100 } })], 1000);
    session("new.jsonl", [
      "not json",
      event({ plan_type: "pro", primary: { used_percent: 30, window_minutes: 300, resets_at: NOW / 1000 + 600 }, secondary: { used_percent: 70, window_minutes: 10080, resets_at: NOW / 1000 - 5 } }),
      `{"payload":{"other":1}}`,
    ], 2000);
    expect(codexUsage(acct("default"), NOW)).toEqual({
      provider: "codex", account: "ChatGPT", plan: "pro", inUse: false, error: null, asOfMs: null,
      windows: [
        { kind: "primary", group: "session", usedPercent: 30, resetsAtMs: NOW + 600_000, windowMinutes: 300 },
        { kind: "secondary", group: "weekly", usedPercent: 0, resetsAtMs: null, windowMinutes: 10080 },
      ],
    });
  });

  it("is null without any snapshot, and names a non-default account by id", () => {
    expect(codexUsage(acct("default"), NOW)).toBeNull();
    session("a.jsonl", [event({ primary: { used_percent: 1, window_minutes: 300 } })], 1);
    expect(codexUsage(acct("alt"), NOW)?.account).toBe("alt");
    expect(codexLabel("alt")).toBe("alt");
  });
});

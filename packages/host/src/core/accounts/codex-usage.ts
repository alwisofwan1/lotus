import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_ACCOUNT, type Account, type UsageAccount, type UsageWindow } from "./types.js";

const SESSION_MINUTES = 300;
/** A session that never finished a turn has no snapshot; a few files back is plenty. */
const FILES_TO_TRY = 20;

type Obj = Record<string, unknown>;

/** `ChatGPT` for `~/.codex`, the account id otherwise. */
export const codexLabel = (id: string): string => (id === DEFAULT_ACCOUNT ? "ChatGPT" : id);

function jsonlFiles(dir: string, out: { mtime: number; path: string }[]): void {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isDirectory()) jsonlFiles(path, out);
      else if (name.endsWith(".jsonl")) out.push({ mtime: st.mtimeMs, path });
    } catch { /* vanished between readdir and stat */ }
  }
}

function lastRateLimits(path: string): Obj | undefined {
  let lines: string[];
  try { lines = readFileSync(path, "utf8").split("\n"); } catch { return undefined; }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (!line.includes('"rate_limits"')) continue;
    try {
      const limits = ((JSON.parse(line) as Obj)["payload"] as Obj | undefined)?.["rate_limits"];
      if (typeof limits === "object" && limits !== null) return limits as Obj;
    } catch { /* a torn last line */ }
  }
  return undefined;
}

function window(kind: string, raw: unknown, nowMs: number): UsageWindow | undefined {
  const w = raw as Obj | undefined;
  if (typeof w?.["window_minutes"] !== "number") return undefined;
  const minutes = w["window_minutes"];
  const resets = typeof w["resets_at"] === "number" ? w["resets_at"] * 1000 : null;
  // The snapshot is from the last turn; a window that has reset since then is empty now.
  const reset = resets !== null && resets <= nowMs;
  const used = reset ? 0 : w["used_percent"];
  if (typeof used !== "number") return undefined;
  return {
    kind, group: minutes <= SESSION_MINUTES ? "session" : "weekly", usedPercent: used,
    resetsAtMs: reset ? null : resets, windowMinutes: minutes,
  };
}

/** The newest `rate_limits` the Codex CLI wrote under `<CODEX_HOME>/sessions`; null when it never wrote one. */
export function codexUsage(account: Account, nowMs: number): UsageAccount | null {
  const files: { mtime: number; path: string }[] = [];
  jsonlFiles(join(account.dir, "sessions"), files);
  files.sort((a, b) => b.mtime - a.mtime);
  let limits: Obj | undefined;
  for (const f of files.slice(0, FILES_TO_TRY)) {
    limits = lastRateLimits(f.path);
    if (limits !== undefined) break;
  }
  if (limits === undefined) return null;
  const windows = ["primary", "secondary"].flatMap((k) => window(k, limits?.[k], nowMs) ?? []);
  return {
    provider: "codex", account: codexLabel(account.id),
    plan: typeof limits["plan_type"] === "string" ? limits["plan_type"] : null,
    inUse: false, windows, error: null, asOfMs: null,
  };
}

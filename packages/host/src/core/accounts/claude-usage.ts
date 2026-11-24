import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { atomicWriteSync } from "../atomic-write.js";
import { NOT_SIGNED_IN, readCredentials, UsageError, type CredentialDeps } from "./credentials.js";
import { DEFAULT_ACCOUNT, type Account, type UsageAccount, type UsageWindow } from "./types.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const SESSION_MINUTES = 300;
const WEEK_MINUTES = 10_080;

/** Not a `sign-in` message on purpose: an account unused for ~8 h is still signed in, it just cannot be asked. */
export const IDLE = "idle — not used in the last 8 h; numbers update on its next use";
export const RATE_LIMITED = "Anthropic is rate-limiting usage checks — try again in a few minutes";

export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{
  status: number;
  json: () => Promise<unknown>;
}>;

interface Raw { kind?: unknown; group?: unknown; percent?: unknown; resets_at?: unknown; scope?: { model?: { display_name?: unknown } } | null }

/** The server's own `limits[]` list, so a new limit kind shows up without a code change. */
export function parseClaudeLimits(body: unknown): UsageWindow[] {
  const limits = (body as { limits?: unknown } | null)?.limits;
  if (!Array.isArray(limits)) return [];
  const out: UsageWindow[] = [];
  for (const raw of limits as Raw[]) {
    if (typeof raw.kind !== "string" || typeof raw.group !== "string" || typeof raw.percent !== "number") continue;
    const group = raw.group === "session" ? "session" : "weekly";
    const resets = typeof raw.resets_at === "string" ? Date.parse(raw.resets_at) : NaN;
    const scope = raw.scope?.model?.display_name;
    out.push({
      kind: raw.kind,
      group,
      usedPercent: raw.percent,
      resetsAtMs: Number.isNaN(resets) ? null : resets,
      windowMinutes: group === "session" ? SESSION_MINUTES : WEEK_MINUTES,
      ...(typeof scope === "string" ? { scope } : {}),
    });
  }
  return out;
}

/** Last good numbers per account, so an idle account still shows where it stood. */
export class LastKnownStore {
  constructor(private readonly file: string) {}

  private read(): Record<string, { atMs: number; windows: UsageWindow[] }> {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Record<string, { atMs: number; windows: UsageWindow[] }>;
    } catch {
      return {};
    }
  }

  save(id: string, windows: UsageWindow[], atMs: number): void {
    mkdirSync(dirname(this.file), { recursive: true });
    atomicWriteSync(this.file, { ...this.read(), [id]: { atMs, windows } });
  }

  /** A window that has reset since the save is empty now. */
  load(id: string, nowMs: number): { atMs: number; windows: UsageWindow[] } | undefined {
    const last = this.read()[id];
    if (last === undefined) return undefined;
    const windows = last.windows.map((w) =>
      w.resetsAtMs !== null && w.resetsAtMs <= nowMs ? { ...w, usedPercent: 0, resetsAtMs: null } : w,
    );
    return { atMs: last.atMs, windows };
  }
}

export interface ClaudeUsageDeps {
  creds: CredentialDeps;
  fetch: FetchLike;
  now: () => number;
  lastKnown: LastKnownStore;
}

/** One account's numbers. Never refreshes a token: that would rotate the one the CLI holds. */
export async function claudeUsage(account: Account, deps: ClaudeUsageDeps): Promise<UsageAccount> {
  const row: UsageAccount = {
    provider: "claude", account: account.id, plan: null, inUse: false, windows: [], error: null, asOfMs: null,
  };
  try {
    const creds = await readCredentials(account.dir, account.id === DEFAULT_ACCOUNT, deps.creds);
    const oauth = (creds as { claudeAiOauth?: { subscriptionType?: unknown; expiresAt?: unknown; accessToken?: unknown } } | null)?.claudeAiOauth;
    if (oauth === undefined || oauth === null) throw new UsageError(NOT_SIGNED_IN);
    row.plan = typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : null;
    // A past `expiresAt` gets 429 from this endpoint, not 401, so it is not worth a request; 0 = not recorded.
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt > 0 && oauth.expiresAt < deps.now()) throw new UsageError(IDLE);
    if (typeof oauth.accessToken !== "string") throw new UsageError(NOT_SIGNED_IN);
    const response = await deps.fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
    }).catch((e: unknown) => { throw new UsageError(`network: ${e instanceof Error ? e.message : String(e)}`); });
    if (response.status === 401 || response.status === 403) throw new UsageError("sign-in expired — open Claude on this account once");
    if (response.status === 429) throw new UsageError(RATE_LIMITED);
    if (response.status < 200 || response.status > 299) throw new UsageError(`usage API: HTTP ${response.status}`);
    row.windows = parseClaudeLimits(await response.json());
    deps.lastKnown.save(account.id, row.windows, deps.now());
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    row.error = e.message;
    if (e.message === IDLE) {
      const last = deps.lastKnown.load(account.id, deps.now());
      if (last !== undefined) { row.windows = last.windows; row.asOfMs = last.atMs; }
    }
  }
  return row;
}

/** Subscription limits per account, as `usage_snapshot` (src-tauri/src/usage.rs) returns them. */
export interface UsageWindow {
  /** The provider's own name: `session`, `weekly_all`, `weekly_opus`, `primary`, … */
  kind: string;
  /** `session` (5 h) or `weekly` (7 d). */
  group: string;
  usedPercent: number;
  resetsAtMs: number | null;
  windowMinutes: number;
  /** The model a scoped limit covers, e.g. "Fable" for `weekly_scoped`. */
  scope?: string | null;
}

export interface UsageAccount {
  provider: "claude" | "codex" | "antigravity";
  account: string;
  plan: string | null;
  /** The Claude account new terminal agents run under. */
  inUse: boolean;
  windows: UsageWindow[];
  error: string | null;
  /** Set when `windows` are the last saved numbers, not fresh: when they were fetched (unix ms). */
  asOfMs?: number | null;
  /** Who is signed in, from the account's own state file; absent when signed out. */
  identity?: { email: string; org: string | null };
}

export type UsageTone = "ok" | "warn" | "full";

export function windowLabel(window: UsageWindow): string {
  if (window.group === "session") return "5-hour";
  if (window.scope) return window.scope;
  const scope = window.kind.replace(/^weekly_?/, "");
  if (!scope || scope === "all" || window.kind === "secondary") return "Weekly";
  return scope.charAt(0).toUpperCase() + scope.slice(1);
}

export function usageTone(percent: number): UsageTone {
  return percent >= 100 ? "full" : percent >= 80 ? "warn" : "ok";
}

/** How far through its window we are, 0–1: usage left of this mark is on pace. */
export function windowPace(window: UsageWindow, now: number): number | null {
  if (window.resetsAtMs == null) return null;
  const left = (window.resetsAtMs - now) / (window.windowMinutes * 60_000);
  return Math.min(1, Math.max(0, 1 - left));
}

/** "12:20 PM" within a day, else "Thu 7:00 PM" — minutes kept so a 24h locale reads "Sun 18:00", not a date-like "Sun, 18". */
export function resetLabel(resetsAtMs: number | null, now: number): string {
  if (resetsAtMs == null) return "";
  const at = new Date(resetsAtMs);
  if (resetsAtMs - now < 86_400_000) return `resets ${at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  return `resets ${at.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

/** "in 3h 52m" within a day, else "Sat 6:59 AM": a clock time alone cannot say today or tomorrow. */
export function resetIn(resetsAtMs: number | null, now: number): string {
  if (resetsAtMs == null) return "";
  const ms = Math.max(0, resetsAtMs - now);
  if (ms >= 86_400_000) return new Date(resetsAtMs).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `in ${h ? `${h}h ${m}m` : `${Math.max(1, m)}m`}`;
}

/** The weekly figure the chip shows: the all-models weekly window, else the first weekly one. */
export function weeklyWindow(account: UsageAccount): UsageWindow | undefined {
  const weekly = account.windows.filter((w) => w.group === "weekly");
  return weekly.find((w) => w.kind === "weekly_all") ?? weekly[0];
}

/** The account the chip speaks for: the Claude login in use, else the first one with numbers. */
/** Only a missing or rejected login needs Sign in; idle and rate-limited rows are still signed in (usage.rs messages). */
export const needsSignIn = (a: UsageAccount) => a.provider === "claude" && /^(not signed in|sign-in expired)/.test(a.error ?? "");

export function chipAccount(accounts: UsageAccount[]): UsageAccount | undefined {
  return accounts.find((a) => a.inUse) ?? accounts.find((a) => a.windows.length > 0);
}

/** Another machine's usage, as `usage_remote` (src-tauri/src/remote_usage.rs) returns it. */
export interface MachineUsage {
  /** The SSH target, as the operator wrote it. */
  target: string;
  /** The machine's own hostname. */
  machine: string;
  state: "live" | "not-connected" | "old-host" | "error";
  accounts: UsageAccount[];
  error: string | null;
  /** When `accounts` were fetched, unless `live`. */
  asOfMs: number | null;
}

export interface ShownAccount extends UsageAccount {
  /** The SSH target it belongs to; `null` for this Mac. */
  target: string | null;
  /** Set when one subscription is signed in on several machines: every machine's label. */
  signedInOn?: string[];
}

export interface MachineGroup {
  target: string | null;
  label: string;
  state: MachineUsage["state"];
  error: string | null;
  asOfMs: number | null;
  accounts: ShownAccount[];
}

const THIS_MAC = "This Mac";

/** A machine key (`user@host:port`, see `sshKey`) as the operator names it: the host, plus a port that is not 22. */
export const machineLabel = (key: string): string => key.replace(/^[^@]*@/, "").replace(/:22$/, "");

/**
 * This Mac first, then every other machine; an account signed in on several machines (same email
 * and organization) is shown once, where its numbers are freshest (PLAN §6). No identity, no merge.
 */
export function machineGroups(local: UsageAccount[], remotes: MachineUsage[]): MachineGroup[] {
  const groups: MachineGroup[] = [
    { target: null, label: THIS_MAC, state: "live", error: null, asOfMs: null, accounts: local.map((a) => ({ ...a, target: null })) },
    ...remotes.map((m) => ({
      target: m.target,
      label: machineLabel(m.target),
      state: m.state,
      error: m.error,
      asOfMs: m.asOfMs,
      accounts: m.accounts.map((a) => ({ ...a, target: m.target })),
    })),
  ];
  // Live numbers beat saved ones, newer saved beat older, and anything with numbers beats an error.
  const rank = (g: MachineGroup, a: ShownAccount): number => {
    const asOf = g.state === "live" ? a.asOfMs : (a.asOfMs ?? g.asOfMs);
    if (g.state === "live" && !a.error) return Number.MAX_SAFE_INTEGER;
    return asOf != null ? asOf + 1 : 0;
  };
  // Per login, the best row on each machine; two folders on ONE machine with the same login both stay.
  const best = new Map<string, { group: MachineGroup; account: ShownAccount; on: string[] }>();
  for (const group of groups) {
    const firstHere = new Set<string>();
    for (const account of group.accounts) {
      if (account.provider !== "claude" || !account.identity) continue;
      const key = `${account.identity.email}|${account.identity.org ?? ""}`;
      if (firstHere.has(key)) continue;
      firstHere.add(key);
      const seen = best.get(key);
      if (!seen) best.set(key, { group, account, on: [group.label] });
      else {
        seen.on.push(group.label);
        if (rank(group, account) > rank(seen.group, seen.account)) Object.assign(seen, { group, account });
      }
    }
  }
  const drop = new Set<ShownAccount>();
  for (const b of best.values()) {
    if (b.on.length < 2) continue;
    b.account.signedInOn = b.on;
    for (const group of groups) {
      if (group === b.group) continue;
      for (const a of group.accounts) if (a.identity?.email === b.account.identity?.email && a.identity?.org === b.account.identity?.org) drop.add(a);
    }
  }
  for (const group of groups) group.accounts = group.accounts.filter((a) => !drop.has(a));
  return groups;
}

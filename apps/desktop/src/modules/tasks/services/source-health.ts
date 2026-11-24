/**
 * What state a ticket source is in, and the words for it (plans/ticket-sources PLAN S40, mockup
 * `SOURCES 06`, task "Ticket Sources 05").
 *
 * One function, so the nav row, the list banner and Connectors cannot drift apart: each prints a
 * part of the same answer.
 */

/**
 * As Rust reports it after a sync (`lotus_automation::notion::sync::SourceHealth`, and GitHub's
 * `github_issues::sync::IssueSourceHealth`, which speaks the same JSON). Why access was lost is the
 * source's own: Notion's token or sharing; GitHub's `gh` login, the account's access, or the repo.
 */
export type SourceHealth =
  | { state: "healthy" }
  | { state: "offline"; message: string }
  | { state: "slowed_down"; retryAtMs: number }
  | { state: "lost_access"; why: LostAccessWhy }
  | { state: "fields_changed"; fields: FieldProblem[] }
  | { state: "failed"; message: string };

export type LostAccessWhy = "token" | "unshared" | "login" | "access" | "repo";

/** A mapped field Lotus can no longer read: gone (`nowKind: null`), or now another type. */
export interface FieldProblem {
  field: "title" | "key" | "status" | "assignee" | "labels" | "parent";
  nowKind: string | null;
}

/** Lotus's names for the fields, as the mapping sheet labels them. */
export const FIELD_LABELS: Record<FieldProblem["field"], string> = {
  title: "Title",
  key: "Key",
  status: "Status",
  assignee: "Assignee",
  labels: "Labels",
  parent: "Parent",
};

export type HealthState = SourceHealth["state"] | "syncing" | "reading";

/** What the one button beside a banner does. */
export type HealthAction = "retry" | "reconnect" | "how_to_share" | "remap";

export interface HealthView {
  state: HealthState;
  /** The dot's colour: fine, working, waiting on something, or needs the person. */
  tone: "ok" | "busy" | "warn" | "bad";
  /** The nav row's one line, and Connectors'. */
  line: string;
  /** The list banner; null when there is nothing to say. */
  banner: string | null;
  action: HealthAction | null;
}

export const HEALTH_ACTION_LABELS: Record<HealthAction, string> = {
  retry: "Retry",
  reconnect: "Reconnect",
  how_to_share: "How to share",
  remap: "Remap fields",
};

export interface HealthInput {
  /** The kind's name: `Notion`. */
  label: string;
  /** The source's own name, which a banner names. */
  name: string;
  /** The last sync's answer; null before one came back. */
  health: SourceHealth | null;
  /** A sync is running now. */
  syncing: boolean;
  /** When the copy on screen was read. */
  syncedAtMs: number | null;
  nowMs: number;
}

export function describeHealth({ label, name, health, syncing, syncedAtMs, nowMs }: HealthInput): HealthView {
  const shown = syncedAtMs ? clock(syncedAtMs) : null;
  const asOf = shown ? ` Showing tickets as of ${shown}.` : "";
  // A problem stays said while the next sync runs: a banner that vanished every minute for a
  // second, to come straight back, would read as the problem coming and going.
  if (!health || health.state === "healthy") {
    if (syncing) return quiet("syncing", "busy", `${label} · syncing…`);
    if (!health) return quiet("reading", "busy", `${label} · reading…`);
    return quiet("healthy", "ok", `${label} · synced ${ago(syncedAtMs, nowMs)}`);
  }
  switch (health.state) {
    case "offline":
      return {
        state: "offline",
        tone: "warn",
        line: shown ? `${label} · offline, showing ${shown}` : `${label} · offline`,
        banner: `You are offline.${asOf}`,
        action: "retry",
      };
    case "slowed_down":
      return {
        state: "slowed_down",
        tone: "warn",
        line: `${label} · slowed down, retrying`,
        banner: `${label} asked Lotus to slow down. Retrying in ${wait(health.retryAtMs - nowMs)} — nothing is lost.`,
        action: null,
      };
    case "lost_access":
      return {
        state: "lost_access",
        tone: "bad",
        line: `${label} · no access`,
        banner: `Lotus can no longer see ${name}. ${LOST_ACCESS_WHY[health.why]?.(label) ?? ""}`.trim(),
        action: LOST_ACCESS_ACTION[health.why] ?? "retry",
      };
    case "fields_changed": {
      const one = health.fields.length === 1;
      const names = listed(health.fields.map((f) => FIELD_LABELS[f.field] ?? f.field));
      return {
        state: "fields_changed",
        tone: "warn",
        line: `${label} · ${health.fields.length} ${one ? "field needs" : "fields need"} you`,
        banner: `The ${names} ${one ? "field was" : "fields were"} removed or changed type in ${label}. Tickets still show; changes are paused until you remap ${one ? "it" : "them"}.`,
        action: "remap",
      };
    }
    case "failed":
      return {
        state: "failed",
        tone: "bad",
        line: `${label} · could not sync`,
        banner: `${label} could not be read (${health.message}).${asOf}`,
        action: "retry",
      };
  }
}

const LOST_ACCESS_WHY: Record<LostAccessWhy, (label: string) => string> = {
  token: (label) => `The ${label} token was revoked or has expired.`,
  unshared: () => "It was unshared or moved to trash.",
  // GitHub (ADR-0048 §9): the fix is in a terminal or on GitHub, never in Lotus — then Retry.
  login: () => "Its GitHub account is not signed in to gh. Run gh auth login in a terminal, then Retry.",
  access: () => "Its GitHub account may no longer read this repo.",
  repo: () => "The repo was deleted, renamed or made private, or its issues were turned off.",
};

const LOST_ACCESS_ACTION: Record<LostAccessWhy, HealthAction> = {
  token: "reconnect",
  unshared: "how_to_share",
  login: "retry",
  access: "retry",
  repo: "retry",
};

function quiet(state: HealthState, tone: HealthView["tone"], line: string): HealthView {
  return { state, tone, line, banner: null, action: null };
}

/** `Status`, `Status and Assignee`, `Status, Assignee and Labels`. */
function listed(names: string[]): string {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function ago(ms: number | null, nowMs: number): string {
  if (!ms) return "";
  const minutes = Math.floor((nowMs - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return clock(ms);
}

function wait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`;
}

function clock(ms: number): string {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

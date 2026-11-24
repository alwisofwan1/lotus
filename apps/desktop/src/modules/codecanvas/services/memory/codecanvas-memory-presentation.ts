import type { CodeCanvasMemoryItem } from "@/lib/tauri/codecanvas";
import { KIND_WEIGHT, PROMPT_KINDS } from "./codecanvas-memory-read-model";

/**
 * Human-facing presentation of memory kinds. Labels and glyphs are presentation only — the stored
 * `kind` string and the MCP vocabulary agents write are untouched, so nothing here needs a migration.
 * Colour roles map onto the theme-independent status ramp (`--canvas-status-*`), never onto
 * `--canvas-accent`, which resolves to a near-white in every builtin theme.
 */
export type MemoryKindColorRole = "rule" | "decision" | "blocker" | "handoff" | "evidence" | "neutral";

export interface MemoryKindPresentation {
  /** The string as it lives in the store. */
  stored: string;
  label: string;
  /** Plural label used for group headers and filter chips. */
  plural: string;
  glyph: string;
  colorRole: MemoryKindColorRole;
  /** True when this kind lands in an agent's prompt — derived from PROMPT_KINDS, never hardcoded. */
  reachesAgents: boolean;
  /** One line teaching what the kind means, shown while composing. */
  blurb: string;
}

interface KindSpec {
  label: string;
  plural: string;
  glyph: string;
  colorRole: MemoryKindColorRole;
  blurb: string;
}

const KIND_SPECS: Record<string, KindSpec> = {
  constraint: {
    label: "Rule",
    plural: "Rules",
    glyph: "§",
    colorRole: "rule",
    blurb: "A hard limit. Injected first into every agent working in this project.",
  },
  decision: {
    label: "Decision",
    plural: "Decisions",
    glyph: "→",
    colorRole: "decision",
    blurb: "Settled. Agents are told not to relitigate it without a new decision.",
  },
  fact: {
    label: "Fact",
    plural: "Facts",
    glyph: "≡",
    colorRole: "neutral",
    blurb: "How this system actually behaves. Every agent here reads it.",
  },
  blocker: {
    label: "Blocker",
    plural: "Blockers",
    glyph: "×",
    colorRole: "blocker",
    blurb: "An open obstacle. Archive it once resolved so agents stop seeing it.",
  },
  handoff: {
    label: "Handoff",
    plural: "Handoffs",
    glyph: "↔",
    colorRole: "handoff",
    blurb: "State passed from one agent to the next.",
  },
  evidence: {
    label: "Evidence",
    plural: "Evidence",
    glyph: "⎿",
    colorRole: "evidence",
    blurb: "Something verified, with the observation attached.",
  },
  summary: {
    label: "Summary",
    plural: "Summaries",
    glyph: "≣",
    colorRole: "neutral",
    blurb: "Condensed history of a run or a thread.",
  },
  note: {
    label: "Note",
    plural: "Notes",
    glyph: "✎",
    colorRole: "neutral",
    blurb: "Yours only. Agents never receive notes; pick Fact or Decision to steer their work.",
  },
  "external-context": {
    label: "Imported",
    plural: "Imported",
    glyph: "↓",
    colorRole: "neutral",
    blurb: "Promoted from another tool's memory. Not injected into agent prompts.",
  },
  artifact: {
    label: "Artifact",
    plural: "Artifacts",
    glyph: "◇",
    colorRole: "neutral",
    blurb: "A produced file or output recorded against this project.",
  },
};

/** Kinds a human can author from the panel. Agents write the fuller vocabulary over MCP. */
export const MEMORY_COMPOSE_KINDS = ["note", "constraint", "decision", "fact", "blocker"] as const;

/**
 * Display order: everything the read model ranks, heaviest first, then the UI-known kinds it never
 * injects. Derived from KIND_WEIGHT so the panel cannot drift from the agent's reading order.
 */
const KIND_DISPLAY_ORDER: string[] = (() => {
  const weighted = Object.keys(KIND_SPECS)
    .filter((kind) => KIND_WEIGHT[kind] !== undefined)
    .sort((a, b) => (KIND_WEIGHT[b] ?? 0) - (KIND_WEIGHT[a] ?? 0));
  const unweighted = Object.keys(KIND_SPECS).filter((kind) => KIND_WEIGHT[kind] === undefined);
  return [...weighted, ...unweighted];
})();

export function memoryKindReachesAgents(kind: string): boolean {
  return PROMPT_KINDS.has(kind);
}

export function describeMemoryKind(kind: string): MemoryKindPresentation {
  const spec = KIND_SPECS[kind];
  if (!spec) {
    return {
      stored: kind,
      label: kind,
      plural: kind,
      glyph: "·",
      colorRole: "neutral",
      reachesAgents: memoryKindReachesAgents(kind),
      blurb: "Written by an agent over MCP.",
    };
  }
  return { stored: kind, ...spec, reachesAgents: memoryKindReachesAgents(kind) };
}

export function describeMemoryActor(item: CodeCanvasMemoryItem): string {
  if (item.source === "human" || item.actorKind === "human") return "you";
  return item.actorId?.trim() || "agent";
}

const SCOPE_ID_MAX = 8;

function shortId(value: string): string {
  return value.length <= SCOPE_ID_MAX ? value : value.slice(0, SCOPE_ID_MAX);
}

/** The narrowest scope the row carries, matching the labels used in the agent prompt block. */
export function describeMemoryScope(item: CodeCanvasMemoryItem): string {
  if (item.assignmentKey) return `assignment · ${shortId(item.assignmentKey)}`;
  if (item.runId) return `run · ${shortId(item.runId)}`;
  if (item.nodeId) return `node · ${shortId(item.nodeId)}`;
  if (item.sessionId) return `session · ${shortId(item.sessionId)}`;
  return "project-wide";
}

/** The store protects pinned rows from retention via a tag, not via `importance`. */
export const MEMORY_PINNED_TAG = "pinned";

export function isMemoryPinned(item: CodeCanvasMemoryItem): boolean {
  return item.tags.includes(MEMORY_PINNED_TAG);
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const YEAR = 52 * WEEK;

export function formatMemoryAge(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}d`;
  if (elapsed < YEAR) return `${Math.floor(elapsed / WEEK)}w`;
  return `${Math.floor(elapsed / YEAR)}y`;
}

export function countMemoryKinds(items: CodeCanvasMemoryItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return counts;
}

export interface MemoryKindGroup {
  kind: string;
  label: string;
  reachesAgents: boolean;
  items: CodeCanvasMemoryItem[];
}

/** Groups in the same order agents receive them, so the panel teaches the real precedence. */
export function groupMemoryItemsByKind(items: CodeCanvasMemoryItem[]): MemoryKindGroup[] {
  const buckets = new Map<string, CodeCanvasMemoryItem[]>();
  for (const item of items) {
    const bucket = buckets.get(item.kind);
    if (bucket) bucket.push(item);
    else buckets.set(item.kind, [item]);
  }
  const ordered = [...buckets.keys()].sort((a, b) => {
    const rankA = KIND_DISPLAY_ORDER.indexOf(a);
    const rankB = KIND_DISPLAY_ORDER.indexOf(b);
    return (rankA < 0 ? Number.MAX_SAFE_INTEGER : rankA) - (rankB < 0 ? Number.MAX_SAFE_INTEGER : rankB);
  });
  return ordered.map((kind) => {
    const presentation = describeMemoryKind(kind);
    return {
      kind,
      label: presentation.plural,
      reachesAgents: presentation.reachesAgents,
      items: buckets.get(kind) ?? [],
    };
  });
}

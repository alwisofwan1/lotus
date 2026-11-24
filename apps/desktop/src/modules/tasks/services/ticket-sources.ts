import type { TaskSource } from "@/modules/codespace/services/bridge/task-store";
import type { HealthView } from "@/modules/tasks/services/source-health";
import { parseTaskKey } from "@/modules/tasks/services/task-key";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";

/**
 * A ticket source: a project in the tracker whose rows come from outside Lotus.
 *
 * A workspace holds Lotus's own tasks. A ticket source holds somebody else's record — an Obsidian
 * vault on this Mac, a Notion database — and Lotus shows it beside the workspaces. Every place that
 * used to ask "is this THE vault?" asks "is this a ticket source, and of which kind?" instead, so a
 * second kind is a new source rather than a second set of special cases
 * (`plans/ticket-sources/PLAN.md` S1–S2).
 */

/** The kinds that exist. `github` is one repo's issues, read only (ADR-0048). */
export type TicketSourceKind = "obsidian" | "notion" | "github";

export interface TicketSourceMeta {
  kind: TicketSourceKind;
  /** The one line the nav prints under the source's name: which tool, and how it is doing. */
  syncLine: string;
  /** Its state in full — the dot, the list banner, its action (`source-health.ts`). */
  health?: HealthView;
  /**
   * Its tickets are matched with notes in the Obsidian vault by key (`TKT-1008` ↔ `TKT-1008.md`,
   * PLAN S37). Only a Notion source sets it, and only when its owner turned "Match notes by key" on.
   */
  matchesNotes?: boolean;
}

/** The name people call each kind by — what the nav line and the empty states say. */
export const TICKET_SOURCE_LABELS: Record<TicketSourceKind, string> = {
  obsidian: "Obsidian",
  notion: "Notion",
  github: "GitHub",
};

/**
 * The source kind a stored task's backlink points into. A task says `vault` for an Obsidian ticket
 * because that is what tasks on disk already say; the tracker calls the same thing `obsidian`.
 */
export function ticketSourceKindOfTask(kind: TaskSource["kind"]): TicketSourceKind {
  return kind === "vault" ? "obsidian" : kind;
}

export function isTicketSource(project: Pick<TrackerProject, "source"> | undefined): boolean {
  return Boolean(project?.source);
}

/*
  A ticket source's manual order lives in the layout, keyed `<source id>:<ref>`.

  Before sources, the only one was the vault, and its keys were bare file names. Two sources can
  each hold a `TKT-1.md` (a vault file, a Notion page with that title), so a bare key is no longer
  enough to say whose place it is. Bare keys are still READ — as the Obsidian source's, which is
  the only one that ever wrote them — and are rewritten with their prefix the next time that source
  is reordered, so a manual order made before this change survives it.
*/

export function ticketPlaceKey(sourceId: string, ref: string): string {
  return `${sourceId}:${ref}`;
}

/**
 * The place of one row, or undefined when it was never moved.
 *
 * `ownsBareKeys` is true for the Obsidian source: the keys written before sources existed are its.
 */
export function readTicketPlace(
  order: Readonly<Record<string, number>>,
  sourceId: string,
  ref: string,
  ownsBareKeys: boolean,
): number | undefined {
  const prefixed = order[ticketPlaceKey(sourceId, ref)];
  if (prefixed !== undefined) return prefixed;
  return ownsBareKeys ? order[ref] : undefined;
}

/**
 * The order after some of one source's rows were moved.
 *
 * Keeps every OTHER source's places untouched. For this source it keeps only rows it still holds —
 * a file deleted or renamed in Obsidian must not keep a place forever — carries a bare legacy key
 * over under its prefix, and then applies the writes.
 */
export function writeTicketPlaces(
  order: Readonly<Record<string, number>>,
  sourceId: string,
  liveRefs: ReadonlySet<string>,
  writes: ReadonlyArray<{ id: string; position: number }>,
  ownsBareKeys: boolean,
): Record<string, number> {
  const prefix = ticketPlaceKey(sourceId, "");
  const next: Record<string, number> = {};

  for (const [key, place] of Object.entries(order)) {
    if (key.startsWith(prefix)) continue;
    // A bare key that names one of this source's rows is its legacy place, rewritten below.
    if (ownsBareKeys && liveRefs.has(key)) continue;
    // A bare key for a file this source no longer holds is dropped, as it always was.
    if (ownsBareKeys && !isPrefixedKey(key)) continue;
    next[key] = place;
  }

  for (const ref of liveRefs) {
    const place = readTicketPlace(order, sourceId, ref, ownsBareKeys);
    if (place !== undefined) next[ticketPlaceKey(sourceId, ref)] = place;
  }
  for (const write of writes) {
    if (liveRefs.has(write.id)) next[ticketPlaceKey(sourceId, write.id)] = write.position;
  }
  return next;
}

/**
 * Whether a key was written with a source prefix.
 *
 * Source ids are Lotus's own (`vault` today, generated ids later) and never contain a dot, while
 * every ref the Obsidian source wrote bare is a file name ending in `.md`. So a key is prefixed
 * when the part before its first `:` has no dot in it.
 */
function isPrefixedKey(key: string): boolean {
  const colon = key.indexOf(":");
  return colon > 0 && !key.slice(0, colon).includes(".");
}

/*
  Notes by key (PLAN S37, S39): a Notion ticket and the Obsidian note written about it.

  This is the ONE place the two sources meet. Neither source's code knows the other exists: the
  Notion source only says it wants its tickets matched, the vault only lists its files, and the
  match is made here, over rows both already put on the board. No vault, or the option off, and
  the answer is empty — nothing downstream draws a trace of this feature.
*/

/** A key as matching compares it: `tkt-1008`, `TKT-1008` and `TKT-01008` are the same ticket. */
function matchKey(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const parsed = parseTaskKey(raw.trim());
  return parsed ? `${parsed.prefix.toUpperCase()}-${parsed.number}` : null;
}

/** A note's own name: its file's, without folders or `.md`. */
function noteStem(file: string): string {
  const name = file.split("/").pop() ?? file;
  return name.replace(/\.md$/i, "");
}

/**
 * For every ticket of a source that matches notes, the vault row written about it — keyed by the
 * ticket's row id, valued with the note's row id (its file).
 *
 * A note matches by its file name first (`TKT-1008.md`, what the vault's convention names a
 * ticket's note) and otherwise by the key its front matter declares. Two notes claiming one key:
 * the one named after it wins, then the first listed, so the answer never flips between reads.
 */
export function notesByKey(
  tasks: readonly TrackerTask[],
  projectsById: ReadonlyMap<string, Pick<TrackerProject, "source">>,
): Map<string, string> {
  const matches = new Map<string, string>();
  const wanting = tasks.filter((task) => projectsById.get(task.projectId)?.source?.matchesNotes);
  if (wanting.length === 0) return matches;

  const byName = new Map<string, string>();
  const byDeclared = new Map<string, string>();
  for (const task of tasks) {
    if (projectsById.get(task.projectId)?.source?.kind !== "obsidian") continue;
    const named = matchKey(noteStem(task.id));
    if (named && !byName.has(named)) byName.set(named, task.id);
    const declared = matchKey(task.key);
    if (declared && !byDeclared.has(declared)) byDeclared.set(declared, task.id);
  }
  if (byName.size === 0 && byDeclared.size === 0) return matches;

  for (const task of wanting) {
    const key = matchKey(task.key);
    if (!key) continue;
    const note = byName.get(key) ?? byDeclared.get(key);
    if (note) matches.set(task.id, note);
  }
  return matches;
}

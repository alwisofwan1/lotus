/**
 * What the "add pane" menu can open.
 *
 * A preset is a LINEUP, not a launch: it names how many sessions will start, which kind each one
 * is and what role it plays, so the menu can show that before anything spawns. Spawning several
 * agents is the one action in this shell that costs real money and real machine, and a lineup
 * shown after the fact is not a review.
 */

import type { PaneKind } from "@/modules/workspace-shell/types";

export interface PaneOption {
  kind: PaneKind;
  label: string;
  /** One line on what this pane is FOR — not a restatement of its name. */
  detail: string;
  /**
   * The chord that opens it, written as a macOS one and translated for the eyes elsewhere by
   * `formatShortcut`. Every entry here is implemented in `paneShortcutKind` — this field is a
   * promise to the reader, not decoration, and `pane-presets.test.ts` holds the two together.
   */
  shortcut: string;
}

export const PANE_OPTIONS: PaneOption[] = [
  { kind: "terminal", label: "Terminal", detail: "a real shell — any TUI runs", shortcut: "⌘T" },
  { kind: "thread", label: "Thread", detail: "an agent you read, not one you watch", shortcut: "⌘⇧T" },
  { kind: "browser", label: "Browser", detail: "verify it where it runs", shortcut: "⌘⇧B" },
  { kind: "editor", label: "Editor", detail: "read and edit the project files", shortcut: "⌘E" },
];

export interface PresetMember {
  kind: PaneKind;
  role: string;
}

export interface SquadPreset {
  id: string;
  label: string;
  /** What the squad is for, in the words someone would use to choose it. */
  detail: string;
  lineup: PresetMember[];
}

export const SQUAD_PRESETS: SquadPreset[] = [
  {
    id: "solo",
    label: "Solo",
    detail: "one session, one attention",
    lineup: [{ kind: "terminal", role: "Builder" }],
  },
  {
    id: "pair",
    label: "Pair",
    detail: "one writes, one checks",
    lineup: [
      { kind: "terminal", role: "Builder" },
      { kind: "thread", role: "Reviewer" },
    ],
  },
  {
    id: "workbench",
    label: "Workbench",
    detail: "write, check, prove",
    lineup: [
      { kind: "terminal", role: "Builder" },
      { kind: "thread", role: "Reviewer" },
      { kind: "browser", role: "Evidence" },
    ],
  },
  {
    id: "fleet",
    label: "Fleet",
    detail: "two parallel tracks, one gate",
    lineup: [
      { kind: "terminal", role: "Builder · track A" },
      { kind: "terminal", role: "Builder · track B" },
      { kind: "thread", role: "Reviewer" },
      { kind: "browser", role: "Evidence" },
      { kind: "editor", role: "Files" },
    ],
  },
];

export function findPreset(presetId: string): SquadPreset | null {
  return SQUAD_PRESETS.find((preset) => preset.id === presetId) ?? null;
}

export function sessionCount(preset: SquadPreset): number {
  return preset.lineup.length;
}

/**
 * The count as a phrase, because English does not let a number carry its own plural.
 *
 * Written once here rather than at each of the three places the menu prints it: "Solo · 1 panes"
 * shipped for exactly as long as it took to look at the running app.
 */
export function panesLabel(count: number): string {
  return `${count} ${count === 1 ? "pane" : "panes"}`;
}

/**
 * How many of the lineup actually start a process. Browser and editor panes are surfaces, not
 * runners — counting them as "sessions" would overstate what the button is about to spend.
 */
export function runnerCount(preset: SquadPreset): number {
  return preset.lineup.filter((member) => member.kind === "terminal" || member.kind === "thread").length;
}

export function describeLineup(preset: SquadPreset): string {
  const runners = runnerCount(preset);
  const surfaces = sessionCount(preset) - runners;
  const runnerText = `${runners} agent${runners === 1 ? "" : "s"}`;
  return surfaces > 0 ? `${runnerText} · ${surfaces} surface${surfaces === 1 ? "" : "s"}` : runnerText;
}

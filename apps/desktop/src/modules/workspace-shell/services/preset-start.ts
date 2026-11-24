import type { PaneKind } from "@/modules/workspace-shell/types";
import type { SquadPreset } from "@/modules/workspace-shell/services/pane-presets";

/**
 * Starting a squad, as an ordered list of pane openings.
 *
 * The menu could always SHOW a lineup — who starts, in what role — and its commit button did
 * nothing but close the menu, under a note promising "tidak ada proses yang lahir sampai kamu
 * menekan mulai". Pressing it still gave birth to nothing.
 *
 * The step that was missing is this one, and it is kept pure so the promise can be tested without
 * a workspace: each kind maps to the SAME constructor the add-pane menu uses for that kind, so a
 * squad cannot drift into a second way of opening a pane.
 */

export type PaneOpener = () => string | null;

/** One opener per kind. `null` means "this machine could not open it" — see `startSquadPreset`. */
export type PaneOpeners = Record<PaneKind, PaneOpener>;

export interface SquadStart {
  /** The panes that were actually opened, in lineup order. */
  paneIds: string[];
  /** Lineup members whose opener declined, so the caller can say what it could not start. */
  skipped: PaneKind[];
}

/**
 * Open every member of the lineup, in order, and report what happened.
 *
 * A member that cannot be opened is SKIPPED rather than aborting the squad: a thread needs a chat
 * template the build may not have, and losing the two terminals as well would turn a partial
 * failure into a total one. The caller still learns which kinds were dropped, because a squad that
 * silently starts fewer panes than its lineup showed is the same lie as a button that does
 * nothing.
 */
export function startSquadPreset(preset: SquadPreset, openers: PaneOpeners): SquadStart {
  const paneIds: string[] = [];
  const skipped: PaneKind[] = [];

  for (const member of preset.lineup) {
    const paneId = openers[member.kind]();
    if (paneId) paneIds.push(paneId);
    else skipped.push(member.kind);
  }

  return { paneIds, skipped };
}

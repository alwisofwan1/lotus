import { machineHostConversation, machineHostDispatch, machineHostFleet, type RemoteHostCell, type RemoteHostFleet } from "@/lib/tauri-api";
import { wireTarget, type Machine } from "./machine";

export type { RemoteHostCell, RemoteHostFleet };

/**
 * A Standalone Host that happens to already be running on the project's machine.
 *
 * **The prize is continuity, not spawning.** SSH already spawns. What only the host can give is a
 * cell that was started from the phone showing up on the canvas — and the other way round.
 *
 * **And it is never a requirement.** A machine that runs no host answers `available: false`, which
 * is not an error and must draw nothing at all. Everything in tickets 01–10 works without it.
 */
const EMPTY: RemoteHostFleet = { available: false, cells: [] };

/**
 * What the project's machine is running under its own host.
 *
 * A local project has no host to ask, and a failure answers "none" rather than throwing: this feeds
 * an optional section of the command sheet, and a machine having a bad day must not take the
 * palette down with it.
 */
export async function hostFleetFor(
  location: Machine | null | undefined,
): Promise<RemoteHostFleet> {
  if (!location) return EMPTY;
  return machineHostFleet(wireTarget(location)).catch(() => EMPTY);
}

/** Send a prompt to a host-owned cell. Errors propagate — the operator typed this on purpose. */
export async function hostDispatchFor(
  location: Machine,
  paneId: string,
  command: string,
): Promise<void> {
  return machineHostDispatch(wireTarget(location), paneId, command);
}

/**
 * A headless cell's conversation, as the host's own `ConversationPage`.
 *
 * Errors propagate, the same as dispatch and unlike `hostFleetFor`: an adopted node asked for this
 * one cell on purpose, and a node that silently shows an empty conversation is indistinguishable
 * from a cell that has not been spoken to yet. `machine_host_conversation` also fails rather than
 * answering an empty page when the pane is a `tui` cell, which is the same distinction one layer
 * down — see `remote_lotus_host.rs`.
 */
export async function hostConversationFor(
  location: Machine,
  paneId: string,
): Promise<unknown> {
  return machineHostConversation(wireTarget(location), paneId);
}

/**
 * What shape a cell can be adopted into — the one branch ticket 12 turns on.
 *
 * Reading this through a named function rather than `cell.tui` at each call site is not ceremony:
 * the field is optional on the wire, an older host omits it, and "absent" must mean *terminal*.
 * Getting that default backwards sends the canvas looking for a conversation on a cell that has
 * none, which is the exact failure ticket 11 shipped and ticket 12 was written to correct.
 */
export function adoptionShapeFor(cell: RemoteHostCell): "terminal" | "chat" {
  return cell.tui === false ? "chat" : "terminal";
}

/**
 * The tmux session a host-owned cell lives in.
 *
 * Copied from `packages/host`'s `sessionName`, character scrub and all, because this is how an
 * adopted node finds the bytes: the host runs its cells under tmux, so a canvas terminal attaches
 * over SSH instead of trying to own a PTY it did not start. A name that disagrees by one character
 * attaches to nothing — or to a session that is not ours.
 */
export function tmuxSessionFor(paneId: string): string {
  return `lotus-${paneId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** What to call a cell in a list: what the host named it, else the directory it runs in. */
export function cellLabel(cell: RemoteHostCell): string {
  return cell.displayName?.trim() || cell.cwd.split("/").filter(Boolean).at(-1) || cell.paneId;
}

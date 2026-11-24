import type { FleetMember } from "../../types/fleet.js";

/**
 * What a cell will do about permissions, decided from what it is being launched with.
 *
 * Pure, and separate from the runners, because two places need the same answer and they
 * run at different times: the spawn builds the command line, and `toFleetMember` reports
 * the posture to a phone that may ask minutes later. ADR-8 fixes a cell's posture for its
 * life, so those two answers must be the same one.
 *
 * `undefined` means **unknown**, never ungated — see `FleetMember.gating`.
 */
export function gatingFor(
  provider: string,
  permissionMode: string | undefined,
): FleetMember["gating"] {
  if (provider === "claude") {
    // Nothing chosen means nothing known. Until 2026-09-06 this answered `asks`, on the reasoning
    // that claude with no flag asks per action — and a cell spawned that way came up
    // `⏵⏵ auto mode on` on devbox-vps, because the effective mode can come from state this host
    // cannot see. `undefined` is the honest answer, and `FleetMember.gating` already means
    // *unknown* by absence, never *ungated*.
    if (permissionMode === undefined) return undefined;
    // The only two values that turn the gate off: claude's own flag name, and the phone's word
    // for it. Everything else — `manual`, `plan`, `acceptEdits` — still asks, because
    // `acceptEdits` widens what may be written without removing the prompt for anything else,
    // and `plan` may change nothing.
    return permissionMode === "bypassPermissions" || permissionMode === "yolo"
      ? "skipped"
      : "asks";
  }
  // A terminal Codex has no hook mechanism to ask through. Not `skipped`: that would read
  // as a choice somebody made and could unmake by respawning, and this one cannot be.
  // (A structured Codex is different — it asks over its protocol — and never comes here.)
  if (provider === "codex") return "runner_cannot";
  return undefined;
}

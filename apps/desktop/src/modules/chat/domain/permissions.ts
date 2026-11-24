// What the agent may do without asking. Shared by the start screen, the composer's picker and the
// Claude translator (which reports a mode the session switched to on its own, e.g. after ExitPlanMode).

import type { PermissionMode } from "../runtime/chat-runtime-client";

export const PERMISSION_MODES: readonly { mode: PermissionMode; label: string; detail: string }[] = [
  { mode: "plan", label: "Plan only", detail: "Reads, never changes files" },
  { mode: "default", label: "Ask before edits", detail: "Asks before commands and edits" },
  { mode: "acceptEdits", label: "Allow edits", detail: "Asks only to leave the folder" },
  { mode: "bypassPermissions", label: "Allow everything", detail: "No asking, no sandbox" },
];

export function permissionLabel(mode: string): string {
  return PERMISSION_MODES.find((m) => m.mode === mode)?.label ?? mode;
}

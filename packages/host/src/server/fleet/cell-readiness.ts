/**
 * Classifies a PTY cell's output tail into a readiness state, so the Director
 * can tell when a worker has returned to a prompt / is blocked / is still busy.
 * Ported from the desktop `mcp_ipc.rs` classifier so `/v1/wait-cell-idle`
 * behaves identically on either host (ADR-0019).
 */

export type CellReadiness =
  | "ready_shell" | "ready_tui" | "dialog" | "auth_required" | "unknown_tui" | "busy";

export interface Classification {
  readiness: CellReadiness;
  matched: string | null;
  suggestedInput: string | null;
}

/** Agent TUIs render these once their input prompt is up (post-boot). */
const READY_TUI_SIGNATURES = ["? for shortcuts", "esc to interrupt", "ctrl+c to exit", "openai codex", "model: gpt-"];
const READY_SHELL_SIGNATURES = ["\n$ ", "\n% ", "\n> "];
const AUTH_REQUIRED_PATTERNS = [
  "mcp server needs", "please sign in", "please log in",
  "authentication required", "approval required", "authorize this",
];
const DIALOG_PATTERNS: ReadonlyArray<{ needle: string; autoDismiss: string | null }> = [
  { needle: "press enter to continue", autoDismiss: "\r" },
  { needle: "press any key", autoDismiss: "\r" },
  { needle: "(y/n)", autoDismiss: null },
  { needle: "[y/n]", autoDismiss: null },
  { needle: "continue?", autoDismiss: null },
];
const DIALOG_WINDOW = 256;

/** Strips ANSI CSI (`ESC[…`), OSC (`ESC]…BEL/ST`), and other `ESC`-prefixed sequences. */
export function stripAnsi(input: string): string {
  let out = "";
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] !== "\x1b") { out += input[i]; continue; }
    const next = input[i + 1];
    if (next === "[") {
      i += 2;
      while (i < input.length && !(input[i]! >= "@" && input[i]! <= "~")) i += 1;
    } else if (next === "]") {
      i += 2;
      while (i < input.length && input[i] !== "\x07" && !(input[i - 1] === "\x1b" && input[i] === "\\")) i += 1;
    } else {
      i += 1; // skip the single char after ESC
    }
  }
  return out;
}

function looksLikeAnsiTui(raw: string, clean: string): boolean {
  if (!raw.includes("\x1b")) return false;
  const visible = [...clean].filter((c) => !/\s/.test(c)).length;
  const escapes = raw.split("\x1b").length - 1;
  return escapes >= 4 && visible <= 24;
}

export function classifyCellState(rawTail: string, customSignatures?: string[]): Classification {
  const lowered = rawTail.toLowerCase();
  const clean = stripAnsi(lowered);
  if (customSignatures && customSignatures.length > 0) {
    for (const sig of customSignatures) {
      if (clean.includes(sig)) return { readiness: "ready_shell", matched: sig, suggestedInput: null };
    }
  } else {
    for (const sig of READY_TUI_SIGNATURES) {
      if (clean.includes(sig)) return { readiness: "ready_tui", matched: sig, suggestedInput: null };
    }
    for (const sig of READY_SHELL_SIGNATURES) {
      if (clean.includes(sig)) return { readiness: "ready_shell", matched: sig, suggestedInput: null };
    }
  }
  const window = clean.slice(-DIALOG_WINDOW);
  for (const pat of AUTH_REQUIRED_PATTERNS) {
    if (window.includes(pat)) return { readiness: "auth_required", matched: pat, suggestedInput: null };
  }
  for (const pat of DIALOG_PATTERNS) {
    if (window.includes(pat.needle)) return { readiness: "dialog", matched: pat.needle, suggestedInput: pat.autoDismiss };
  }
  if (looksLikeAnsiTui(lowered, clean)) return { readiness: "unknown_tui", matched: "ansi_tui_output", suggestedInput: null };
  return { readiness: "busy", matched: null, suggestedInput: null };
}

const SETTLED: ReadonlySet<CellReadiness> = new Set(["ready_shell", "ready_tui", "dialog", "auth_required", "unknown_tui"]);

export function isSettled(state: CellReadiness): boolean {
  return SETTLED.has(state);
}
export function isIdle(state: CellReadiness): boolean {
  return isSettled(state);
}
export function legacyState(state: CellReadiness): "ready" | "dialog" | "busy" {
  if (state === "ready_shell" || state === "ready_tui" || state === "unknown_tui") return "ready";
  if (state === "dialog" || state === "auth_required") return "dialog";
  return "busy";
}

/** Agent CLIs take longer to render their first prompt than a bare shell. */
export function defaultWaitTimeoutMs(provider?: string): number {
  switch (provider?.toLowerCase()) {
    case "codex": case "gemini": case "opencode": return 15_000;
    case "cursor": case "copilot": return 12_000;
    case "claude": case "claude-headless": case "ccs-hss": case "ccs-hss-headless": return 10_000;
    default: return 8_000;
  }
}

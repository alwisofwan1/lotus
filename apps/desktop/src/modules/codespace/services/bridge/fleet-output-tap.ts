import type { ExecutorProviderId } from "@/modules/codespace/components/types";
import type { CellBus } from "./cell-event-bus";
import { detectFleetProvider } from "./fleet-naming";

/**
 * Strip CSI/OSC/charset-designation/basic ESC sequences so plain-text matching works.
 *
 * The charset branch (`ESC ( B`, `ESC ) 0`) was added 2026-09-10: it is ESC plus TWO bytes, so the
 * single-char ESC branch never matched it, and a Claude pane that ends its output with `ESC ( B`
 * made "(B" the entire fleet preview for every member.
 *
 * Bare C0 control bytes go with it — the same live tail carried SI (0x0f) after the escape, and a
 * control byte is not text, so a "line" made only of those must not win the preview. `\n`, `\r`
 * and `\t` are kept: the line-splitting below is what interprets them.
 */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[@-Z\\-_]/g;

const C0_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "").replace(C0_RE, "");
}

const MAX_LAST_LINE = 120;

/** Best-effort provider sniffer from raw PTY output. */
export function detectProviderFromOutput(raw: string): ExecutorProviderId | null {
  // A real banner beats the loose hints below: Codex's footer also reads "? for shortcuts".
  const banner = detectProviderLaunchBanner(raw);
  if (banner) return banner;
  const text = stripAnsi(raw).toLowerCase();
  if (text.includes("claude code") || text.includes("? for shortcuts")) return "claude";
  if (text.includes("ccs hss")) return "ccs-hss";
  if (text.includes("github copilot")) return "copilot";
  if (text.includes("gemini cli") || text.includes("gemini") && text.includes("google")) return "gemini";
  if (text.includes("opencode")) return "opencode";
  if (text.includes("cursor-agent") || text.includes("cursor cli")) return "cursor";
  if (/\bcodex\b/.test(text)) return "codex";
  return null;
}

export function extractLastLine(raw: string): string {
  const stripped = stripAnsi(raw);
  // Resolve carriage-return line overrides (progress bars etc.).
  const normalized = stripped.replace(/\r\n/g, "\n").split("\n").map((chunk) => {
    const parts = chunk.split("\r");
    return parts[parts.length - 1] ?? "";
  });
  for (let i = normalized.length - 1; i >= 0; i -= 1) {
    const trimmed = normalized[i].trim();
    if (trimmed) return trimmed.length > MAX_LAST_LINE ? trimmed.slice(0, MAX_LAST_LINE) : trimmed;
  }
  return "";
}

/**
 * Strong provider-SWITCH signal (04). `detectProviderFromOutput` is loose substring
 * matching — fine for a pane's FIRST detection (there's no existing label to knock loose),
 * but re-detecting on an ALREADY-labeled pane must not fire on an agent merely typing the
 * provider's name in a reply — everyone in this repo types "codex" routinely. This only
 * matches a CLI's own startup banner text, never prose.
 *
 * Only Codex, Claude, Grok, Pi, Antigravity and Cursor have a confirmed literal banner to key on (the live bug report:
 * `>_ OpenAI Codex (v0.154.0)`; Grok's footer `Grok Build  1.0.77 [stable]`; pi 1.5.2 and agy 1.5.9 startup
 * screens, 2026-11-16). Other providers keep whatever they were first detected as
 * until a real banner for them is verified live — silence is safer than a guessed marker.
 */
function detectProviderLaunchBanner(raw: string): ExecutorProviderId | null {
  const text = stripAnsi(raw);
  // First: Pi's footer names its backend "(openai-codex)" and agy's names "Gemini 3.8 Flash".
  if (text.includes("Pi can explain its own features")) return "pi";
  if (text.includes("Antigravity CLI")) return "antigravity";
  // Codex's composer placeholder: its banner can scroll out of the buffer behind the braille logo.
  if (text.includes("OpenAI Codex") || text.includes("Ask Codex to do anything")) return "codex";
  if (text.includes("Claude Code")) return "claude";
  if (text.includes("Grok Build")) return "grok";
  // Its splash: the name, then a dated version (cursor-agent v2026.10.01, signed out, 2026-11-16).
  if (/Cursor Agent\s+v\d{4}\.\d{2}\.\d{2}/.test(text)) return "cursor";
  return null;
}

// The CLIs above. When a pane was launched with one of them, it prints its own banner first, so a
// different banner seen before any relaunch is its reply quoting another CLI (Pi saying "Claude Code").
const HAS_OWN_BANNER = new Set<string>(["pi", "antigravity", "codex", "claude", "grok", "cursor"]);

export type FleetOutputHints = {
  /**
   * What the pane's output says is running. Pass the pane's launch command: a loose text guess
   * that disagrees with a known launch is dropped (Pi's footer "(openai-codex)" read as Codex), and so
   * is another CLI's banner quoted in a reply (Pi saying "Claude Code"). A banner overrules the launch
   * only after a relaunch, or when the launched CLI has no banner of its own (ccs hss runs Claude).
   */
  getDetectedProvider: (paneId: string, agentCommand?: string) => ExecutorProviderId | null;
  getLastLine: (paneId: string) => string;
  getTail: (paneId: string, lineLimit: number) => string;
};

export type FleetOutputTap = FleetOutputHints & {
  /** Panes whose agent has handed the terminal back to its shell since the last call (drains). */
  takeEndedAgents: () => string[];
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
};

type Internal = {
  providers: Map<string, ExecutorProviderId>;
  lines: Map<string, string>;
  buffers: Map<string, string>;
  switchTails: Map<string, string>;
  /** Panes whose shell started a new command (OSC 133;C) since their provider was recorded. */
  commandStarted: Set<string>;
  /** Panes whose provider came from a CLI's own launch banner, not a loose text guess. */
  fromBanner: Set<string>;
  /** Panes whose provider came from a banner printed after the shell started a new command. */
  fromRelaunch: Set<string>;
  endedAgents: Set<string>;
  listeners: Set<() => void>;
};

// Lotus's shell integration prints this before every prompt (src-tauri/src/pty/scripts).
const SHELL_COMMAND_DONE = "\x1b]133;D";
// Printed by the same integration right before a typed command runs.
const SHELL_COMMAND_START = "\x1b]133;C";

const BUFFER_BYTES = 4096;

// (04 follow-up) A launch banner can straddle a PTY chunk boundary — not hypothetical: live
// fleet previews the same day showed "canel" (from "cancel") and "aces.\"," (from
// "workspaces.\","), so mid-word chunk splits happen here routinely. "OpenAI Codex" arriving
// as "OpenAI Co" + "dex" would never match a single-chunk check. Big enough to outlast any
// banner used today with room to spare, small enough that a banner scrolls out of it again
// within a chunk or two — which is what keeps the flip-flop risk of rewinding the full 4KB
// buffer from coming back.
const SWITCH_WINDOW_BYTES = 128;

function notify(state: Internal) {
  for (const listener of Array.from(state.listeners)) {
    try {
      listener();
    } catch (err) {
      console.error("[fleet-output-tap] listener threw", err);
    }
  }
}

export function createFleetOutputTap(bus: CellBus): FleetOutputTap {
  const state: Internal = {
    providers: new Map(),
    lines: new Map(),
    buffers: new Map(),
    switchTails: new Map(),
    commandStarted: new Set(),
    fromBanner: new Set(),
    fromRelaunch: new Set(),
    endedAgents: new Set(),
    listeners: new Set(),
  };

  const unsubOutput = bus.on("terminal:output", ({ paneId, data }) => {
    if (state.providers.has(paneId) && data.includes(SHELL_COMMAND_DONE)) {
      // The shell is back at its prompt, so the agent it was running has exited. Forget its
      // output too, or the banner still in the buffer would label the shell all over again.
      state.providers.delete(paneId);
      state.buffers.delete(paneId);
      state.switchTails.delete(paneId);
      state.commandStarted.delete(paneId);
      state.fromBanner.delete(paneId);
      state.fromRelaunch.delete(paneId);
      state.endedAgents.add(paneId);
      notify(state);
      return;
    }
    const prevBuffer = state.buffers.get(paneId) ?? "";
    const nextBuffer = (prevBuffer + data).slice(-BUFFER_BYTES);
    state.buffers.set(paneId, nextBuffer);

    // Stitch a small trailing window from the PREVIOUS chunk onto this one before checking
    // for a switch banner, so one split across a chunk boundary is still seen whole. Updated
    // unconditionally (even before a pane has any provider yet) so it's always ready the
    // moment a switch becomes possible.
    const priorTail = state.switchTails.get(paneId) ?? "";
    const switchWindow = (priorTail + data).slice(-SWITCH_WINDOW_BYTES);
    state.switchTails.set(paneId, switchWindow);

    if (data.includes(SHELL_COMMAND_START)) state.commandStarted.add(paneId);

    let changed = false;
    const existingProvider = state.providers.get(paneId) ?? null;
    if (!existingProvider) {
      // First detection: as permissive as before — nothing to protect yet, and this is
      // the only way a pane gets a label at all.
      const banner = detectProviderLaunchBanner(nextBuffer);
      const detected = banner ?? detectProviderFromOutput(nextBuffer);
      if (detected) {
        state.providers.set(paneId, detected);
        if (banner) state.fromBanner.add(paneId);
        state.commandStarted.delete(paneId);
        changed = true;
      }
    } else {
      // Provider switch (04): a pane can be handed off to a different CLI in the same PTY
      // (claude exits, codex starts), so re-evaluation can't just stop after the first hit
      // like it used to — that's how a switched pane stayed mislabeled forever. But the
      // loose match used for first detection would let an agent's reply merely CONTAINING
      // "codex" falsely trigger a switch, so this requires a strong launch banner, checked
      // against the small stitched `switchWindow` — not the single raw chunk (a banner can
      // split across chunks) and not the rolling 4KB `nextBuffer` (a banner that has already
      // scrolled past must not keep re-firing on every later chunk).
      //
      // And only after the shell started a new command (OSC 133;C). A running agent prints
      // banner text too: Claude showing a diff of this file put "OpenAI Codex" on screen and
      // relabelled a Claude pane as Codex (2026-11-17). Panes without shell integration
      // (ssh, tmux) therefore keep their first label.
      const relaunched = state.commandStarted.has(paneId) ? detectProviderLaunchBanner(switchWindow) : null;
      if (relaunched && relaunched !== existingProvider) {
        state.providers.set(paneId, relaunched);
        state.fromBanner.add(paneId);
        state.fromRelaunch.add(paneId);
        state.commandStarted.delete(paneId);
        changed = true;
      }
    }

    const lastLine = extractLastLine(data) || extractLastLine(nextBuffer);
    if (lastLine && state.lines.get(paneId) !== lastLine) {
      state.lines.set(paneId, lastLine);
      changed = true;
    }

    if (changed) notify(state);
  });

  const unsubExit = bus.on("terminal:exited", ({ paneId }) => {
    state.providers.delete(paneId);
    state.lines.delete(paneId);
    state.buffers.delete(paneId);
    state.switchTails.delete(paneId);
    state.commandStarted.delete(paneId);
    state.fromBanner.delete(paneId);
    state.fromRelaunch.delete(paneId);
    notify(state);
  });

  return {
    getDetectedProvider: (paneId, agentCommand) => {
      const provider = state.providers.get(paneId) ?? null;
      if (!provider || state.fromRelaunch.has(paneId)) return provider;
      const launched = detectFleetProvider(agentCommand);
      if (launched === "shell" || launched === provider) return provider;
      return state.fromBanner.has(paneId) && !HAS_OWN_BANNER.has(launched) ? provider : null;
    },
    getLastLine: (paneId) => state.lines.get(paneId) ?? "",
    getTail: (paneId, lineLimit) => extractTail(state.buffers.get(paneId) ?? "", lineLimit),
    takeEndedAgents: () => {
      const ended = Array.from(state.endedAgents);
      state.endedAgents.clear();
      return ended;
    },
    subscribe: (listener) => {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
    dispose: () => {
      unsubOutput();
      unsubExit();
      state.listeners.clear();
      state.providers.clear();
      state.fromBanner.clear();
      state.fromRelaunch.clear();
      state.lines.clear();
      state.buffers.clear();
      state.switchTails.clear();
      state.commandStarted.clear();
      state.endedAgents.clear();
    },
  };
}

function extractTail(raw: string, lineLimit: number): string {
  const limit = Math.max(1, Math.floor(lineLimit));
  const stripped = stripAnsi(raw).replace(/\r\n/g, "\n");
  const lines = stripped
    .split("\n")
    .map((line) => {
      const parts = line.split("\r");
      return parts[parts.length - 1] ?? "";
    })
    .filter((line, index, all) => line.trim() !== "" || index < all.length - 1);
  return lines.slice(-limit).join("\n").trim();
}

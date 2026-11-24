/**
 * Reconstruct the ask an operator typed into an agent pane, from the raw PTY input stream
 * (`plans/agent-headlines/` — headlines for every runner).
 *
 * **Why this exists rather than reading a hook.** The headline is the operator's ask, and for
 * Claude-family agents that arrives free on a `prompt-submit` drop. Codex reports only turn ends
 * (`codex-notify.sh` posts to `/v1/hook/stop`), and `cursor` and `custom` have no hook mechanism at
 * all — so every one of those panes would carry no headline forever, which is most of the fleet on a
 * mixed board.
 *
 * Lotus already knows, though. `LiveAgentNode` funnels *every* input path — typing, paste, the submit
 * queue, insert, MCP dispatch — through one `ptyWriteRef`, and calls it "the single choke point".
 * Watching that stream gives the ask for any runner, hooks or no hooks, and it covers dispatched work
 * that no human typed at all.
 *
 * **What it can and cannot see.** It sees the bytes Lotus writes, not the CLI's own composer, and the
 * two can diverge. Recall a previous prompt with the up-arrow and press Enter and this buffer is
 * empty; move the cursor into the middle of a line and type, and the text lands at the end here but
 * mid-line there. Both are accepted rather than chased: reconstructing a TUI composer would mean
 * reimplementing its line editor and getting it subtly wrong in a different way.
 *
 * An empty buffer reports nothing, so the caller keeps whatever headline it had — reporting an empty
 * ask would be worse than reporting none, blanking a good title on a keystroke nobody meant as an
 * instruction. And on Claude-family panes the `prompt-submit` drop lands moments later carrying the
 * prompt the CLI actually received, which corrects any divergence for free.
 */

import {
  KITTY_SHIFT_ENTER_SEQUENCE,
  META_ENTER_SEQUENCE,
} from "@/modules/codespace/services/terminal-keybindings";

const ESC = String.fromCharCode(27);

/**
 * How much of a line is kept.
 *
 * A paste is unbounded — an operator can drop a whole file into a composer — and this buffer lives
 * per pane for as long as the board is open. The cap is well above any real instruction and well
 * below anything that matters for memory; the headline itself is trimmed to `PROMPT_MAX` later.
 */
export const ASK_BUFFER_MAX = 2_000;

/** Bracketed-paste envelope. Its CONTENT is literal text: newlines inside it compose, never submit. */
const BRACKETED_PASTE_RE = new RegExp(`${ESC}\\[200~([\\s\\S]*?)${ESC}\\[201~`, "g");

/**
 * CSI and SS3 escape sequences — arrows, home/end, function keys, mouse reports, and the kitty
 * chords. None of them are text, and letting one through would write `[A` into the middle of an ask.
 *
 * The parameter class is the FULL CSI range 0x30–0x3F (`0-9:;<=>?`), not just digits and `?`.
 * It used to stop at `?`, and `<` is 0x3C — which is exactly the private-parameter byte SGR mouse
 * reports open with. So `ESC[<0;50;20M` failed the CSI branch, fell through to the single-character
 * escape branch, and lost only `ESC[` — leaving `<0;50;20M` in the buffer as literal text. Every
 * click inside a pane typed itself into the ask. Seen live 2026-09-14: a session titled
 * `<0;50;20M<0;50;20m<0;41;21M<0;4…`.
 */
const ESCAPE_SEQUENCE_RE = new RegExp(`${ESC}(?:\\[[0-9:;<=>?]*[ -/]*[@-~]|O[A-Za-z]|.)`, "g");

/**
 * X10 mouse reports: `ESC[M` followed by three RAW bytes (button, x, y), which are ordinary
 * printable characters. The CSI rule above eats `ESC[M` and would leave those three bytes behind as
 * text, so the whole six-character report is removed as one unit, before it.
 */
const X10_MOUSE_RE = new RegExp(`${ESC}\\[M[\\s\\S]{3}`, "g");

const BACKSPACE = String.fromCharCode(127);
const BACKSPACE_ALT = String.fromCharCode(8);
/** Ctrl+C, Ctrl+U, Ctrl+G, Ctrl+W's larger cousin — anything that abandons the line being composed. */
const LINE_ABANDONED = new Set([
  String.fromCharCode(3),
  String.fromCharCode(21),
  String.fromCharCode(7),
]);

export interface PaneAskStep {
  /** The line so far, after this chunk. */
  buffer: string;
  /** The completed ask, when this chunk ended one. `null` while still composing. */
  submitted: string | null;
}

/** One chunk of literal text, or one control decision, in the order they arrived. */
type Token =
  | { kind: "text"; text: string }
  | { kind: "compose" }
  | { kind: "submit" };

/**
 * Split a write chunk into what it MEANS, before deciding what it does.
 *
 * Order is the whole trick. Bracketed pastes come out first so their newlines can never be read as a
 * submit; the newline-insert chords come out next, because `META_ENTER_SEQUENCE` is ESC + CR and is
 * otherwise indistinguishable from Enter (the same collision that made `inputOpensTurn` treat
 * composing as answering — fixed in `pane-turn-registry.ts` the same day).
 */
function tokenize(data: string): Token[] {
  const tokens: Token[] = [];
  let rest = data;

  // Pastes first, recursing on the text either side so ordering is preserved.
  BRACKETED_PASTE_RE.lastIndex = 0;
  const paste = BRACKETED_PASTE_RE.exec(rest);
  if (paste) {
    const [envelope, content] = paste;
    const at = paste.index;
    tokens.push(...tokenize(rest.slice(0, at)));
    if (content) tokens.push({ kind: "text", text: content });
    tokens.push(...tokenize(rest.slice(at + envelope.length)));
    return tokens;
  }

  for (const sequence of [KITTY_SHIFT_ENTER_SEQUENCE, META_ENTER_SEQUENCE]) {
    const at = rest.indexOf(sequence);
    if (at !== -1) {
      tokens.push(...tokenize(rest.slice(0, at)));
      tokens.push({ kind: "compose" });
      tokens.push(...tokenize(rest.slice(at + sequence.length)));
      return tokens;
    }
  }

  // Whatever is left holds no pastes and no compose chords, so any remaining escape sequence is a
  // cursor key or a report — not text, and not a submit.
  rest = rest.replace(X10_MOUSE_RE, "").replace(ESCAPE_SEQUENCE_RE, "");

  for (const char of rest) {
    if (char === "\r" || char === "\n") tokens.push({ kind: "submit" });
    else tokens.push({ kind: "text", text: char });
  }
  return tokens;
}

/**
 * Fold one PTY write into the line being composed.
 *
 * Pure, and takes the buffer as an argument rather than owning it, so a caller can hold one line per
 * pane however it likes and every branch here is directly testable.
 */
export function applyPaneInput(buffer: string, data: string): PaneAskStep {
  let line = buffer;
  let submitted: string | null = null;

  for (const token of tokenize(data)) {
    if (token.kind === "submit") {
      const ask = line.trim();
      // An empty line is a bare Enter — waking a pane, stepping past a prompt. Not an instruction.
      // Reported as `null` so the caller holds the headline it already has.
      if (ask) submitted = ask;
      line = "";
      continue;
    }
    if (token.kind === "compose") {
      line = clamp(`${line}\n`);
      continue;
    }
    for (const char of token.text) {
      if (char === BACKSPACE || char === BACKSPACE_ALT) line = line.slice(0, -1);
      else if (LINE_ABANDONED.has(char)) line = "";
      // A newline reaching this loop can only have come from PASTED content — `tokenize` turns every
      // other one into a submit — so it is literal text, and dropping it would splice two pasted
      // lines into one word.
      else if (char === "\n" || char === "\r") line = clamp(`${line}\n`);
      // Remaining C0 controls (tab, bell, the rest) carry no meaning for an ask.
      else if (char >= " ") line = clamp(line + char);
    }
  }

  return { buffer: line, submitted };
}

function clamp(line: string): string {
  // Keeps the TAIL, not the head: when a paste overflows, the words nearest the operator's cursor are
  // the ones they were actually looking at.
  return line.length <= ASK_BUFFER_MAX ? line : line.slice(line.length - ASK_BUFFER_MAX);
}

export interface PaneAskBuffer {
  /** Fold a write for one pane. Returns the completed ask when this chunk ended one. */
  note(paneId: string, data: string): string | null;
  /**
   * Stop treating this pane's writes as an ask until the matching {@link resume}.
   *
   * For everything Lotus itself types at the CLI. The launch controller sends three things through
   * the same choke point a human uses — the shell line that starts the runner, the persona bootstrap,
   * and the operator's initial task — and only the last is an ask. The persona is the one that hurt:
   * `live-agent-spawn.ts:62` types it into runners that have no `--append-system-prompt`, which is
   * codex and custom, which is exactly the set this buffer exists to serve. The first Codex pane to
   * get a headline was titled with the canvas persona preamble.
   *
   * Writes arriving while suspended are dropped rather than buffered, so a submit queue's delayed
   * Enter landing after the bracket closes finds nothing to submit.
   *
   * Counted, not a flag: launch writes can overlap, and a boolean would re-open capture on the first
   * one to finish.
   */
  suspend(paneId: string): void;
  /** End one {@link suspend}. Never drops below zero — a stray resume cannot deafen a pane. */
  resume(paneId: string): void;
  /**
   * The line this pane is composing right now, or `""`.
   *
   * Read-only, and advisory by construction — the same divergence this file documents applies
   * (a recalled history line or a mid-line edit is invisible here). Callers must treat an answer
   * as a hint, never as a gate; the Skills node uses it to decide whether an "applied" MARKER is
   * still true, and applying is allowed either way.
   */
  peek(paneId: string): string;
  /** Drop a pane's half-typed line — its node closed, or its session was replaced. */
  clear(paneId: string): void;
}

export function createPaneAskBuffer(): PaneAskBuffer {
  const lines = new Map<string, string>();
  const suspended = new Map<string, number>();

  return {
    note(paneId, data) {
      if ((suspended.get(paneId) ?? 0) > 0) return null;
      const step = applyPaneInput(lines.get(paneId) ?? "", data);
      if (step.buffer) lines.set(paneId, step.buffer);
      else lines.delete(paneId);
      return step.submitted;
    },
    suspend(paneId) {
      suspended.set(paneId, (suspended.get(paneId) ?? 0) + 1);
    },
    resume(paneId) {
      const depth = (suspended.get(paneId) ?? 0) - 1;
      if (depth > 0) suspended.set(paneId, depth);
      else suspended.delete(paneId);
    },
    peek(paneId) {
      return lines.get(paneId) ?? "";
    },
    clear(paneId) {
      lines.delete(paneId);
      // The suspension goes too. A node torn down mid-launch would otherwise leave its pane id
      // permanently suspended, and the next occupant of that id would never get a headline.
      suspended.delete(paneId);
    },
  };
}

/** Process-wide buffer, shared by every live agent pane. */
export const paneAskBuffer: PaneAskBuffer = createPaneAskBuffer();

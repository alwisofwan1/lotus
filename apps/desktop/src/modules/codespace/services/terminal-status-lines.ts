/**
 * Pure heuristics for classifying terminal output lines — shared by agent
 * notifications and the Terminal Activity signal so the working/prompt detection
 * lives in exactly one place.
 */

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd]/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "");
}

export function cleanTerminalLine(input: string): string {
  return stripAnsi(input)
    .replace(CONTROL_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isPromptLike(line: string): boolean {
  const lowered = line.toLowerCase();
  return line === ">"
    || line === "›"
    || line === "$"
    || line === "%"
    || line === "?"
    || line.startsWith("›")
    || lowered.endsWith(" for shortcuts")
    || lowered === "esc to interrupt"
    || lowered.includes("ctrl+c to exit")
    || lowered.startsWith("model: gpt-")
    || /^gpt-[\w.-]+\s+/.test(lowered)
    || lowered.includes("openai codex");
}

/**
 * Claude Code's spinner line, as it is actually printed today.
 *
 * Captured live 2026-09-22 from a pane Rust reported as `turn: running`:
 *
 *   ✳ Discombobulating… (2m 56s · ↓8.4k tokens · thought for 4s)
 *   ✶ Discombobulating… (running PreToolUse hooks… 1/2 · 2m 56s · ↓8.4k tokens …)
 *
 * The verb is randomised per turn, so it cannot be matched. What is stable is the shape: an
 * ellipsis, then a trailing parenthesis carrying either the interrupt hint or an elapsed time
 * beside a token counter. Both halves are required for the timed form, because a lone `(12s)`
 * is a thing ordinary command output prints.
 */
function isSpinnerProgressLine(lowered: string): boolean {
  if (!lowered.includes("…") && !lowered.includes("...")) return false;
  if (!/\([^()]*\)\s*$/.test(lowered)) return false;
  return /\b\d+\s*s\b/.test(lowered) && /\btokens?\b/.test(lowered);
}

export function isWorkingStatusLine(line: string): boolean {
  const lowered = line.toLowerCase();
  return lowered.includes("working(")
    || lowered.startsWith("working (")
    || lowered.startsWith("working ")
    // No leading space: the hint is printed as `Herding… (esc to interrupt)`, so the character
    // before `esc` is `(`, not a space. The old pattern never matched a real Claude Code line.
    || lowered.includes("esc to interrupt")
    || isSpinnerProgressLine(lowered);
}

/**
 * Returns true when the TAIL of an output chunk contains an interactive-agent
 * "ready for input" signal — e.g. the Claude Code status bar showing
 * `auto mode on`. Checks only the last 4 visible lines to avoid false-positives
 * from response content that mentions these phrases mid-text.
 */
export function isAgentReadyLine(rawLine: string): boolean {
  const line = stripAnsi(rawLine).trim();
  if (!line) return false;
  const lowered = line.toLowerCase();
  // Claude Code interactive status bar. Depending on font / terminal glyph
  // fallback, the two leading chevrons can render as ►►, ▸▸, ▶▶ or ⏵⏵.
  //
  // The mode NAME is not matched, only the chevrons plus the cycle hint. `auto mode on` was
  // hardcoded here, so a pane running `bypass permissions on` — the second mode in the same
  // cycle — was never recognised as resting at all (observed 2026-09-22 on a live pane).
  if (/^[►▸▶⏵]{2,}\s/.test(line) && lowered.includes("shift+tab")) return true;
  // Some repaints preserve the status text but not the chevron glyphs.
  if (lowered.includes("shift+tab to cycle")) return true;
  if (lowered.includes("auto mode on") && (lowered.includes("shift+tab") || lowered.includes("for agents"))) return true;
  // Shared agent/shell ready footers. Keep this narrower than isPromptLike():
  // startup banners such as "OpenAI Codex" should not mark the cell idle
  // until a real prompt/footer appears.
  return line === ">"
    || line === "›"
    || line === "$"
    || line === "%"
    || lowered.endsWith(" for shortcuts")
    || lowered.includes("ctrl+c to exit")
    || lowered.includes("context 0% used")
    || (lowered.includes("(auto)") && lowered.includes("(openai-codex)"))
    || lowered.includes("plan, search, build anything")
    || lowered.includes("ask a question or describe a task")
    || lowered.startsWith("model: gpt-")
    || /^gpt-[\w.-]+\s+/.test(lowered);
}

export function hasAgentReadyOutput(raw: string): boolean {
  const lines = stripAnsi(raw)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((line) => line.split("\r"))
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-4).some(isAgentReadyLine);
}

/**
 * How far up the tail a working line may sit.
 *
 * It used to be the LAST line only, and that is why a working agent read as resting: Claude Code
 * draws its spinner ABOVE the persistent status bar, so the bottom of a live repaint is
 *
 *   ✳ Discombobulating… (2m 56s · ↓8.4k tokens)   ← the working line
 *   🤖 Opus 5 (1M context) | …                     ← status bar
 *   📁 ~/workspace/experiments/Lotus               ← cwd
 *   ►► auto mode on (shift+tab to cycle)           ← mode footer
 *
 * The working line is never last while that chrome is on screen. Six lines covers the chrome
 * with room to spare, and matches the window {@link hasAgentReadyOutput} already scans.
 */
const WORKING_TAIL_LINES = 6;

export function hasActiveWorkingStatusTail(raw: string): boolean {
  const lines = stripAnsi(raw)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((line) => line.split("\r"))
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  if (!last) return false;
  if (lines.slice(-WORKING_TAIL_LINES).some(isWorkingStatusLine)) return true;
  const previous = lines.at(-2);
  return /^gpt-[\w.-]+\s+/.test(last.toLowerCase())
    && Boolean(previous && isWorkingStatusLine(previous));
}

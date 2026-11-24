/**
 * OSC 133 shell-integration command-boundary markers, emitted by the Lotus
 * zsh/bash/fish integration scripts: A (prompt start), B (command read),
 * C (command begins executing), D[;exit] (command finished). These back the
 * Terminal Activity signal — see docs/adr/0004. Stripped from visible data the
 * same way the CWD probe strips OSC 7 / OSC 777.
 */

export type Osc133Kind = "prompt-start" | "command-read" | "command-begin" | "command-end";

export type Osc133Event = {
  kind: Osc133Kind;
  /** Present only for `command-end` (the `D;<status>` payload), undefined if absent. */
  exitCode?: number;
};

// ESC ] 133 ; <letter> [; <payload>] (BEL | ST)
const OSC133_PATTERN = /\x1b\]133;([A-D])(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)/g;

const KIND_BY_LETTER: Record<string, Osc133Kind> = {
  A: "prompt-start",
  B: "command-read",
  C: "command-begin",
  D: "command-end",
};

export function parseOsc133(data: string): { visibleData: string; events: Osc133Event[] } {
  const events: Osc133Event[] = [];
  const visibleData = data.replace(OSC133_PATTERN, (_match, letter: string, payload?: string) => {
    const kind = KIND_BY_LETTER[letter];
    if (kind === "command-end") {
      const parsed = payload !== undefined && payload !== "" ? Number.parseInt(payload, 10) : NaN;
      events.push({ kind, exitCode: Number.isFinite(parsed) ? parsed : undefined });
    } else {
      events.push({ kind });
    }
    return "";
  });
  return { visibleData, events };
}

# Terminal Activity is derived from OSC 133 markers plus the agent working-phase

## Status

accepted

## Context

The terminal tile badge showed **Terminal Runtime Status** (`live`/`idle`/…), a
connection-lifecycle value. Users read "LIVE" as "connected" but wanted the tile
to answer a different question: *is the cell actually doing work right now?* That
is **Terminal Activity** (`running`/`idle`) — an axis orthogonal to connection.

A connected cell sits at one of two activity states, and the right signal source
is not obvious. Three candidates:

- **`tcgetpgrp` on the PTY master fd** — accurate at the process level on Unix,
  but ConPTY has no equivalent, and over SSH the local foreground process is
  always `ssh`, so it reports `running` permanently. Process-level only — it
  cannot tell a thinking agent from one waiting for input.
- **Output-activity heuristic** ("output seen in the last N ms") — catches any
  command without a backend, but flickers, misreads TUI prompts, and marks a
  silent `sleep 10` as idle.
- **OSC 133 command-boundary markers** — `C` (command begins) / `D;<exit>`
  (command finished). Already emitted by the Lotus zsh/bash/fish shell-integration
  scripts and currently ignored by xterm. Shell-emitted, so cross-platform and
  SSH-friendly when the remote shell is integrated; carries the exit code.

OSC 133 is coarse for interactive agents: `claude` is one foreground command, so
`C→D` spans the whole REPL session — it would read `running` even while the agent
waits for input. The agent-notification `working` phase (output-tail parsing of
`working(…)` / `esc to interrupt`) already provides the finer "agent is thinking
now" signal.

## Decision

**Terminal Activity** is computed in the shared CodeSpace layer from three signals,
not from `tcgetpgrp`:

- User input sent to the PTY (keystrokes via `term.onData`) → `running` for 800 ms
  after the last keystroke. OSC 133 `command-begin` (Enter) supersedes this via the
  shell-command path below, so the debounce never fires on a submitted command.
- For a plain shell command, `running` spans `OSC 133;C` → `OSC 133;D`.
- For a cell whose foreground command is a detected interactive agent, the
  agent-notification `working` phase governs: `running` only while thinking,
  `idle` while awaiting input — overriding the coarse OSC-133 "process alive".

The tile badge shows **Terminal Activity** while the cell is `live`, falling back
to **Terminal Runtime Status** for non-`live` states (`starting`/`exited`/`failed`).
v1 surfaces the new badge on the Canvas Terminal Node only; the signal lives in the
shared layer so CodeSpace cells and the Agent Fleet can adopt it later without rework.

## Consequences

- OSC 133 must be parsed and stripped from the output stream, mirroring the
  existing OSC 7 / OSC 777 CWD-probe handling, so the markers never reach the view.
- SSH cells degrade gracefully: a non-integrated remote shell emits no OSC 133, so
  remote shell commands won't flip to `running`; agent activity still works because
  the `working` phase reads the visible stream regardless of transport.
- The badge depends on shell integration being active; a shell without it (or a
  raw `terminalCommand` process) shows `running` only via the agent working-phase.

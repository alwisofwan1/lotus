"use client";
import { describeMemoryKind } from "../../services/memory/codecanvas-memory-presentation";

interface Props {
  onSeed: (kind: string) => void;
  /** Dropped once the composer is open, so the call to action is not doubled. */
  showAction?: boolean;
}

const EXAMPLES: { kind: string; text: string }[] = [
  { kind: "constraint", text: "never run the release build against ~/.lotus-dev." },
  { kind: "decision", text: "PTY output streams over an IPC channel, no WebSocket layer." },
  { kind: "fact", text: "the MCP sidecar re-reads its IPC config on every tool call." },
];

/**
 * First run is the only chance to say what this surface is: shared with agents, project-scoped, and
 * not the same thing as Claude's or Codex's private memory.
 */
export function CanvasMemoryEmptyState({ onSeed, showAction = true }: Props) {
  return (
    <div className="canvas-memory-empty">
      <h3>Shared memory for this project</h3>
      <p>
        Rules, decisions and facts written here are injected into every agent that runs in this
        project, and agents write back to the same place. It is not Claude&apos;s or Codex&apos;s private
        memory, and it lives with the project rather than the session.
      </p>
      <ul className="canvas-memory-examples">
        {EXAMPLES.map((example) => {
          const kind = describeMemoryKind(example.kind);
          return (
            <li key={example.kind}>
              <span className="canvas-memory-glyph" data-role={kind.colorRole} aria-hidden>{kind.glyph}</span>
              <span><b>{kind.label}:</b> {example.text}</span>
            </li>
          );
        })}
      </ul>
      {showAction ? (
        <div className="canvas-memory-empty-action">
          <button type="button" className="canvas-memory-btn-primary" onClick={() => onSeed("constraint")}>
            Write the first rule
            <span className="canvas-memory-kbd">⌘⏎</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

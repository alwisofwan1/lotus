"use client";

import "@/styles/conversation-title.css";

import { Pencil } from "lucide-react";
import { useState } from "react";
import { Dither } from "@/modules/chat/ui/Dither";

const band = (u: number) => (u < 0.8 ? 0.5 : (0.5 * (1 - u)) / 0.2);

/**
 * The agent's name in a Code pane header (mockups/agent-rename-code.html, board 1): click to
 * rename, Enter saves, Esc or clicking away cancels. Renaming changes the Agent Handle (ADR-0068).
 * Same field look as `ConversationTitle`, so the two renames in one header read alike.
 */
export function AgentNameControl({
  name,
  onRename,
  startEditing = false,
}: {
  name: string;
  /** Opens already editing: a menu's "Rename agent…" (key the control to reopen it). */
  startEditing?: boolean;
  /** The new name; returns why it was refused, or null when it was taken. */
  onRename: (name: string) => string | null;
}) {
  const [editing, setEditing] = useState(startEditing);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setEditing(false);
    setError(null);
  };

  if (editing) {
    return (
      <span className="conversation-title nodrag nopan" data-editing="true">
        <span className="conversation-title-field">
          <input
            className="conversation-title-input"
            aria-label="Agent name"
            aria-invalid={error ? true : undefined}
            defaultValue={name}
            maxLength={32}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={() => setError(null)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                const refused = event.currentTarget.value.trim() === name ? null : onRename(event.currentTarget.value);
                if (refused) setError(refused);
                else close();
              } else if (event.key === "Escape") close();
              else return;
              event.preventDefault();
            }}
            onBlur={close}
          />
          <Dither className="conversation-title-line" field={band} cell={1} />
        </span>
        {error ? (
          <span className="conversation-title-hint" data-error="" role="alert">
            {error}
          </span>
        ) : (
          <span className="conversation-title-hint" aria-hidden>
            <kbd>↵</kbd> save <kbd>esc</kbd> cancel · the agent is told
          </span>
        )}
      </span>
    );
  }

  return (
    <button type="button" className="ws-agent-name" title={`${name} — click to rename`} onClick={() => setEditing(true)}>
      {name}
      <Pencil size={10} strokeWidth={2} aria-hidden className="ws-agent-name-pen" />
    </button>
  );
}

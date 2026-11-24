"use client";

import { MessageCirclePlus, X } from "lucide-react";
import { useState } from "react";

import { agentPromptFor } from "../services/templates";

export { agentPromptFor };

/**
 * "New automation": describe it, and an agent builds it (PLAN §2.5; bb opens its composer the
 * same way). Inline under the toolbar rather than a modal: the list stays in view, and the
 * request is one textarea. Whatever the agent saves arrives in the list switched off.
 */
export function CreateWithAgent({
  onCreateWithAgent,
  onClose,
}: {
  /** Resolves to `null` once the agent is open, or to why it is not. Absent: nowhere to open one. */
  onCreateWithAgent?: (prompt: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "opening" | { error: string }>("idle");

  const start = async () => {
    if (!onCreateWithAgent || !text.trim()) return;
    setState("opening");
    const error = await onCreateWithAgent(agentPromptFor(text)).catch((e: unknown) => String(e));
    setState(error ? { error } : "idle");
    if (!error) {
      setText("");
      onClose();
    }
  };

  return (
    <div className="au-composer" role="region" aria-label="Describe an automation">
      <textarea
        className="au-composer-input"
        aria-label="Describe an automation"
        placeholder="Every Monday at 08:00, DM me the PRs I still owe a review…"
        rows={3}
        autoFocus
        value={text}
        disabled={state === "opening"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void start();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <div className="au-composer-foot">
        <span className="au-hint">
          {onCreateWithAgent
            ? "Opens a Claude agent with your request — a pane in Code, a node on the canvas. It asks what it needs, shows a summary, and saves the automation switched off."
            : "Open Code mode with a workspace first: the agent needs a pane to run in."}
        </span>
        <span className="au-draft-actions">
          <button type="button" className="rs-icon-button" aria-label="Close" title="Close" onClick={onClose}>
            <X size={14} aria-hidden />
          </button>
          <button
            type="button"
            className="rs-button rs-button--primary"
            disabled={!onCreateWithAgent || !text.trim() || state === "opening"}
            onClick={() => void start()}
          >
            <MessageCirclePlus size={13} aria-hidden />
            {state === "opening" ? "Opening agent…" : "Create with agent"}
          </button>
        </span>
      </div>
      {typeof state === "object" ? (
        <p className="au-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

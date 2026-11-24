"use client";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { CanvasNodeFocusAction } from "./CanvasNodeFocusAction";
import { HostConversationPartView } from "./HostConversationPartView";
import { isTurnOpen, type HostConversationPage } from "../../services/host-conversation";

interface Props {
  label: string;
  cwd: string;
  provider: string;
  page: HostConversationPage | null;
  error: string | null;
  loading: boolean;
  sending: boolean;
  onSend: (prompt: string) => void;
  onClose: () => void;
  onFocus?: () => void;
}

/**
 * The visible surface of an adopted headless cell: its turns, and a box to add one.
 *
 * There is no terminal here and there is not meant to be. The cell this draws has no PTY and no
 * tmux session — pointing an xterm at it would give an empty black rectangle next to an agent
 * that is working, which is worse than not adopting it at all.
 */
export const HostCellNodeCard = memo(function HostCellNodeCard({
  label, cwd, provider, page, error, loading, sending, onSend, onClose, onFocus,
}: Props) {
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const partCount = page?.turns.reduce((total, turn) => total + turn.parts.length, 0) ?? 0;

  // Follow the conversation only while the operator is already at the bottom. Scrolling them back
  // down mid-read is the complaint Pocket's chat collected three separate times.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceFromBottom < 120) element.scrollTop = element.scrollHeight;
  }, [partCount]);

  const submit = useCallback(() => {
    const text = draft.trim();
    if (!text || sending) return;
    onSend(text);
    setDraft("");
  }, [draft, onSend, sending]);

  const busy = isTurnOpen(page?.turns.at(-1));

  return (
    <div className="canvas-hostcell">
      <div className="canvas-hostcell-head canvas-node-header">
        <span className="canvas-hostcell-title">{label}</span>
        <span className="canvas-hostcell-meta">
          {page?.runnerLabel || page?.runner || provider}
          {busy ? <span className="canvas-hostcell-live" aria-label="working" /> : null}
        </span>
        {onFocus && <CanvasNodeFocusAction onFocus={onFocus} className="canvas-hostcell-close canvas-node-focus" iconSize={12} />}
        <button className="canvas-hostcell-close" onClick={onClose} aria-label="Close host cell node">
          <X size={12} aria-hidden />
        </button>
      </div>
      <div className="canvas-hostcell-where" title={cwd}>{cwd}</div>

      {error ? (
        // Beside the conversation, never instead of it: a host restarting must not blank turns
        // the operator is reading.
        <p className="canvas-hostcell-error" role="status">{error}</p>
      ) : null}

      <div className="canvas-hostcell-scroll" ref={scrollRef}>
        {loading && !page ? <p className="canvas-hostcell-empty">Reading the conversation…</p> : null}
        {!loading && page && page.turns.length === 0 ? (
          <p className="canvas-hostcell-empty">No turns yet. Say something below and this cell will answer here.</p>
        ) : null}
        {page?.turns.map((turn) => (
          <div className="canvas-hostcell-turn" key={turn.turnId} data-turn-open={isTurnOpen(turn) ? "true" : undefined}>
            {turn.parts.map((part) => (
              <HostConversationPartView key={part.id} part={part} />
            ))}
          </div>
        ))}
      </div>

      <div className="canvas-hostcell-composer">
        <textarea
          className="canvas-hostcell-input"
          value={draft}
          rows={2}
          placeholder={`Send a prompt to ${label}`}
          aria-label="Prompt for this cell"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter is a newline. Nothing here is typed into a TUI, so the
            // paste-vs-keystroke split that canvas terminals need does not apply: this is one
            // HTTP dispatch carrying the whole prompt.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button className="canvas-hostcell-send" onClick={submit} disabled={sending || !draft.trim()}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
});

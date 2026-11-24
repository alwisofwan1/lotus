"use client";
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Sparkles, Terminal, X } from "lucide-react";
import { CanvasNodeFocusAction } from "./CanvasNodeFocusAction";
import type { AgentRunnerType } from "@/lib/agent-runtime";
import type { NameValidation } from "@/lib/agent-catalog";
import {
  resolveRunnerVisualIdentity,
  type RunnerVisualIdentity,
} from "@/modules/codecanvas/services/runner-visual-identity";

/** One clear message per rejection reason, shown inline while editing the name. */
const RENAME_ERROR: Record<Exclude<NameValidation, { ok: true }>["reason"], string> = {
  empty: "Name can't be empty",
  duplicate: "Another agent already has that name",
  "too-long": "Too long (max 32 characters)",
  "invalid-char": "Use letters, numbers, spaces, - or _",
};

/**
 * Phase tone for the live agent launch lifecycle, plus the one tone that is not a launch phase.
 *
 * `needs-you` comes from a hook fact rather than from the launch controller (see
 * `services/live-agent-presentation.ts`). It lives in this union because the header renders one
 * badge and that badge has to be able to say "waiting for you" — keeping it in a parallel channel
 * is how you end up publishing `needs-you` to the fleet while the badge still reads `run`.
 */
export type LiveAgentPhaseTone =
  | "idle"
  | "starting"
  | "ready"
  | "running"
  | "needs-you"
  | "ended"
  | "error";

/** Badge state derived from phase tone — used as CSS `data-s` attribute.
 *   idle/ended  → dim grey     (agent is idle/finished)
 *   starting    → amber        (agent is booting — transient)
 *   ready       → bright white (agent connected, ready to receive work)
 *   running     → bright white (agent working on a turn)
 *   needs-you   → violet       (a human is required before it can continue)
 *   error       → red          (agent failed)
 *
 * `needs-you` gets its own state rather than borrowing `run`: it must NOT read as progress, and it
 * must not animate. A spinner over "answer me" is precisely the lie this plan removes.
 */
function toneToStatus(tone: LiveAgentPhaseTone): "boot" | "run" | "ask" | "fail" | "idle" {
  if (tone === "error") return "fail";
  if (tone === "ended") return "idle";
  if (tone === "starting") return "boot";
  if (tone === "needs-you") return "ask";
  if (tone === "ready" || tone === "running") return "run";
  return "idle";
}

export interface AgentPersonaHeaderProps {
  /** The agent's display name and cross-agent coordination handle (ADR-0024). */
  name: string;
  runner: AgentRunnerType;
  /** Resolved registry-aware identity. Omitted for built-ins and compatibility callers. */
  runnerIdentity?: RunnerVisualIdentity;
  tone: LiveAgentPhaseTone;
  /**
   * What the agent is working on, shown only when the terminal is not rendered
   * (`plans/agent-headlines/` Slice 4).
   *
   * Passed as `undefined` at full zoom on purpose. A headline exists to answer "what is this agent
   * doing" WITHOUT opening anything, and at full zoom the terminal two lines below already answers
   * it — spending ~14px of chrome on every card to repeat that is the trade this avoids. Below zoom
   * 0.5 `LiveAgentNode` sets `collapsed`, the terminal is gone, and the card has the room precisely
   * then.
   */
  headline?: string;
  /** Persona accent colour (Slice 6). When set it colours the dot; otherwise the dot shows phase. */
  color?: string;
  /** The active conversation's title control, after the runner label. Omitted = none. */
  conversationTitle?: ReactNode;
  /** The account chip of a Claude node, after the runner label. */
  accountChip?: ReactNode;
  /** Toggles focus mode on this node (hero + right rail). Omitted = no focus action shown. */
  onFocusMode?: () => void;
  /** Opens/focuses a Skills node wired to this agent (ADR-0027 Phase 6a: skills dispatch to terminal). */
  onAddSkills?: () => void;
  /** True when a Skills node is already wired to this agent. */
  skillsActive?: boolean;
  /**
   * Commit a new handle (NP.5 rename). Returns the validation verdict so the header can surface an
   * inline error and stay in edit mode on rejection. Omitted = the name is read-only.
   */
  onRename?: (name: string) => NameValidation;
  /**
   * How many conversations this node has recorded. Omitted or zero = no chip
   * (`plans/codecanvas-session-widget/`, Slice 03).
   */
  sessionCount?: number;
  /** Opens this node's session list. Omitted = no chip, whatever the count says. */
  onOpenSessions?: () => void;
  sessionsOpen?: boolean;
  onClose: () => void;
}

const NAME_INPUT_STYLE: React.CSSProperties = {
  font: "inherit",
  color: "inherit",
  background: "rgba(255,255,255,0.08)",
  border: "1px solid rgba(255,255,255,0.25)",
  borderRadius: 4,
  padding: "0 4px",
  width: "10ch",
  minWidth: 0,
  outline: "none",
};

/**
 * CNVS-style live agent header (ADR-0027): a single status/identity badge (logo mask, coloured by
 * phase tone — white when running, amber on boot, red on failure, dim grey when idle), the name
 * (the handoff handle), and the runner label — nothing else. No CLD badge, no model, no
 * YOLO/ready chips: liveness rides the badge colour, and permissions are visible in the terminal
 * body itself.
 *
 * The name is inline-editable when {@link AgentPersonaHeaderProps.onRename} is provided (NP.5):
 * double-click to edit, Enter/blur to commit, Escape to cancel. Validation is delegated to the
 * caller (unique-among-teammates, valid chars) and rejections keep the field open with a reason.
 */
export const AgentPersonaHeader = memo(function AgentPersonaHeader({
  name,
  runner,
  runnerIdentity,
  tone,
  headline,
  color,
  accountChip,
  conversationTitle,
  onFocusMode,
  onAddSkills,
  skillsActive,
  onRename,
  sessionCount = 0,
  onOpenSessions,
  sessionsOpen = false,
  onClose,
}: AgentPersonaHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select the whole name the moment we enter edit mode, so a rename is one gesture.
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const beginEdit = useCallback(() => {
    if (!onRename) return;
    setDraft(name);
    setError(null);
    setEditing(true);
  }, [name, onRename]);

  const cancel = useCallback(() => {
    setEditing(false);
    setError(null);
  }, []);

  const commit = useCallback(() => {
    if (!onRename) return;
    const verdict = onRename(draft);
    if (verdict.ok) {
      setEditing(false);
      setError(null);
    } else {
      // No-op rename (name unchanged) is a friendly exit, not an error.
      if (verdict.reason === "duplicate" && draft.trim().toLowerCase() === name.trim().toLowerCase()) {
        cancel();
        return;
      }
      setError(RENAME_ERROR[verdict.reason]);
    }
  }, [cancel, draft, name, onRename]);

  const identity = runnerIdentity ?? resolveRunnerVisualIdentity({ runner });
  const badgeLogo = identity.mark.kind === "logo" ? identity.mark.src : null;
  const badgeColor = color; // persona colour overrides status colour when set
  return (
    <div
      className="canvas-persona-header"
      data-testid="agent-persona-header"
      data-tone={tone}
      data-runner={runner}
      data-headline={headline ? "true" : undefined}
    >
      <span
        className="canvas-persona-badge"
        data-s={toneToStatus(tone)}
        data-runner={runner}
        data-mark={identity.mark.kind}
        style={{
          // Only set --badge-color if persona colour is actually defined.
          // Otherwise CSS fallback chain (--badge-status → default) works correctly.
          ...(badgeColor ? { "--badge-color": badgeColor } : {}),
          ...(badgeLogo ? { "--badge-logo": `url("${badgeLogo}")` } : {}),
        } as React.CSSProperties}
        aria-label={`${identity.label} — ${tone}`}
        // The logo names the runner; the label it replaced is one hover away.
        title={identity.label}
      >
        {identity.mark.kind === "glyph" ? (
          <span className="canvas-persona-badge-glyph" aria-hidden="true">
            {identity.mark.value}
          </span>
        ) : identity.mark.kind === "terminal" ? (
          <Terminal className="canvas-persona-badge-terminal" size={12} strokeWidth={1.8} aria-hidden="true" />
        ) : null}
      </span>
      {editing ? (
        <input
          ref={inputRef}
          className="canvas-persona-name-input"
          style={NAME_INPUT_STYLE}
          value={draft}
          aria-label="Agent name"
          aria-invalid={error ? true : undefined}
          title={error ?? undefined}
          maxLength={32}
          onChange={(e) => { setDraft(e.target.value); setError(null); }}
          // Keep keystrokes from reaching the canvas keyboard shortcuts while renaming.
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            else if (e.key === "Escape") { e.preventDefault(); cancel(); }
          }}
          onBlur={commit}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="canvas-persona-name"
          title={onRename ? "Double-click to rename" : name}
          style={onRename ? { cursor: "text" } : undefined}
          onDoubleClick={onRename ? beginEdit : undefined}
        >
          {name}
        </span>
      )}
      {conversationTitle && (
        <span className="canvas-persona-title">
          <span className="canvas-persona-sep" aria-hidden>
            ·
          </span>
          {conversationTitle}
        </span>
      )}
      {accountChip}
      {onOpenSessions && sessionCount > 0 && (
        <button
          type="button"
          className="canvas-persona-sessions"
          aria-label={`This node's sessions (${sessionCount})`}
          data-session-list-toggle=""
          aria-expanded={sessionsOpen}
          data-active={sessionsOpen ? "true" : undefined}
          onClick={onOpenSessions}
        >
          {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
        </button>
      )}
      {onFocusMode && <CanvasNodeFocusAction onFocus={onFocusMode} />}
      {onAddSkills && (
        <button
          type="button"
          className="canvas-persona-action"
          aria-label="Skills"
          aria-pressed={skillsActive}
          data-active={skillsActive ? "true" : undefined}
          onClick={onAddSkills}
        >
          <Sparkles size={11} />
        </button>
      )}
      <button type="button" className="canvas-persona-close" aria-label="Close agent" onClick={onClose}>
        <X size={12} />
      </button>
      {/* Last child, absolutely positioned by CSS on its own line — so the header's flex ROW is
          untouched and nothing in it re-flows or truncates differently when a headline appears. */}
      {headline && (
        <span className="canvas-persona-headline" data-testid="agent-headline">
          {headline}
        </span>
      )}
    </div>
  );
});

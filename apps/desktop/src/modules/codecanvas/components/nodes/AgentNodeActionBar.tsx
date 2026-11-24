"use client";
import { memo } from "react";
import type { ReactNode, PointerEvent } from "react";
import { GitBranch, GitCompare, Scan, SquareCode, SquareTerminal, Sparkles, X } from "lucide-react";

export interface AgentNodeActionBarProps {
  onClose: () => void;
  onFocus?: () => void;
  onToggleWT?: () => void;
  wtActive?: boolean;
  onToggleDiff?: () => void;
  diffActive?: boolean;
  onToggleSkills?: () => void;
  skillsActive?: boolean;
  onOpenIde?: () => void;
  onPromoteToTerminal?: () => void;
  promoteToTerminalDisabled?: boolean;
}

/** Keep a button press from reaching React Flow's pan/select handlers. */
function swallow(e: PointerEvent) {
  e.stopPropagation();
}

function Action({
  label, active, disabled, onClick, children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`agent-action${active ? " agent-action--active" : ""}`}
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onPointerDown={swallow}
      onClick={(e) => { e.stopPropagation(); if (!disabled) onClick(); }}
    >
      {children}
    </button>
  );
}

/** The Canvas Agent Action Bar — tool affordances + Kill, mirroring the Terminal action bar. */
export const AgentNodeActionBar = memo(function AgentNodeActionBar({
  onClose,
  onFocus,
  onToggleWT,
  wtActive,
  onToggleDiff,
  diffActive,
  onToggleSkills,
  skillsActive,
  onOpenIde,
  onPromoteToTerminal,
  promoteToTerminalDisabled,
}: AgentNodeActionBarProps) {
  return (
    <div className="agent-actionbar" data-drag-handle="false">
      {onToggleWT && (
        <Action label="Worktree" active={wtActive} onClick={onToggleWT}>
          <GitBranch size={12} aria-hidden />
        </Action>
      )}
      {onToggleSkills && (
        <Action label="Skills" active={skillsActive} onClick={onToggleSkills}>
          <Sparkles size={12} aria-hidden />
        </Action>
      )}
      {onOpenIde && (
        <Action label="Open in IDE" onClick={onOpenIde}>
          <SquareCode size={12} aria-hidden />
        </Action>
      )}
      {onPromoteToTerminal && (
        <Action label="Promote to Terminal" disabled={promoteToTerminalDisabled} onClick={onPromoteToTerminal}>
          <SquareTerminal size={12} aria-hidden />
        </Action>
      )}
      {onToggleDiff && (
        <Action label="Diff" active={diffActive} onClick={onToggleDiff}>
          <GitCompare size={12} aria-hidden />
        </Action>
      )}
      <span className="agent-actionbar-sep" aria-hidden />
      {onFocus && (
        <Action label="Focus" onClick={onFocus}>
          <Scan size={12} aria-hidden />
        </Action>
      )}
      <Action label="Kill agent" onClick={onClose}>
        <X size={12} aria-hidden />
      </Action>
    </div>
  );
});

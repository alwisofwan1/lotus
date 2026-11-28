"use client";

import { X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { TaskPriorityGlyph, TaskStatusGlyph } from "@/modules/tasks/components/TaskGlyphs";
import { closeDetailsOnEscape, useCloseMenusOnOutsidePress } from "@/modules/tasks/components/details-menu";
import {
  statusLabel,
  TASK_PRIORITY_ORDER,
  taskPriorityLabel,
  type StatusVocabulary,
} from "@/modules/tasks/services/task-vocabulary";
import type { BridgePriority, BridgeTaskStatus } from "@/modules/codespace/services/bridge/task-store";
import { useFormatShortcut } from "@/lib/hooks/useShortcutLabel";

/**
 * The bar that floats over the list while rows are ticked (Tasks revamp D8): how many, and the
 * two properties that can be set on all of them at once.
 *
 * Status is offered only when every ticked row speaks one vocabulary — a vault ticket and a Lotus
 * task have different statuses, and a menu offering either would set something wrong on one of
 * them. Its menus open upward, since the bar sits at the foot of the list.
 */
export interface TaskBulkBarProps {
  count: number;
  /** The ticked rows' shared vocabulary; `null` when they do not share one. */
  vocabulary: StatusVocabulary | null;
  canSetPriority: boolean;
  onStatus: (status: BridgeTaskStatus) => void;
  onPriority: (priority: BridgePriority) => void;
  onSelectAll: () => void;
  onClear: () => void;
}

export function TaskBulkBar({
  count,
  vocabulary,
  canSetPriority,
  onStatus,
  onPriority,
  onSelectAll,
  onClear,
}: TaskBulkBarProps) {
  const shortcut = useFormatShortcut();
  useCloseMenusOnOutsidePress();
  return (
    <div className="tk-bulk" role="toolbar" aria-label="Bulk actions">
      <span className="tk-bulk-count">{count} selected</span>
      {vocabulary ? (
        <BulkMenu
          kind="status"
          label="Status"
          options={vocabulary.order}
          render={(option) => (
            <>
              <TaskStatusGlyph status={option as BridgeTaskStatus} vocabulary={vocabulary} decorative />
              <span>{statusLabel(vocabulary, option)}</span>
            </>
          )}
          onPick={(option) => onStatus(option as BridgeTaskStatus)}
        />
      ) : (
        <button
          type="button"
          className="tk-bulk-button"
          disabled
          title="These rows use different statuses (a Lotus task and a vault ticket). Tick rows of one kind to set status."
        >
          Status
        </button>
      )}
      {canSetPriority ? (
        <BulkMenu
          kind="priority"
          label="Priority"
          options={TASK_PRIORITY_ORDER}
          render={(option) => (
            <>
              <TaskPriorityGlyph priority={option as BridgePriority} decorative />
              <span>{taskPriorityLabel(option as BridgePriority)}</span>
            </>
          )}
          onPick={(option) => onPriority(option as BridgePriority)}
        />
      ) : null}
      <span className="tk-bulk-sep" aria-hidden />
      <button type="button" className="tk-bulk-button" onClick={onSelectAll} title={`Select all (${shortcut("⌘A")})`}>
        Select all
      </button>
      <button type="button" className="ws-chrome-button" onClick={onClear} aria-label="Clear selection" title="Clear (Esc)">
        <X size={14} strokeWidth={1.75} />
      </button>
    </div>
  );
}

function BulkMenu({
  kind,
  label,
  options,
  render,
  onPick,
}: {
  kind: "status" | "priority";
  label: string;
  options: readonly string[];
  render: (option: string) => React.ReactNode;
  onPick: (option: string) => void;
}) {
  const pick = (details: HTMLDetailsElement, option: string) => {
    details.removeAttribute("open");
    onPick(option);
  };
  return (
    <details
      data-menu
      data-kind={kind}
      className="tk-chip tk-bulk-menu"
      onToggle={(event) => {
        if (event.currentTarget.open) event.currentTarget.querySelector<HTMLElement>(".tk-chip-option")?.focus();
      }}
      onKeyDown={(event: KeyboardEvent<HTMLDetailsElement>) => {
        const index = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
        if (event.currentTarget.open && index >= 0 && index < options.length) {
          event.preventDefault();
          event.stopPropagation();
          pick(event.currentTarget, options[index]);
          return;
        }
        closeDetailsOnEscape(event);
      }}
    >
      <summary className="tk-bulk-button">{label}</summary>
      <div className="tk-chip-menu" role="menu" aria-label={`Set ${label.toLowerCase()} on selected`}>
        {options.map((option, index) => (
          <button
            key={option}
            type="button"
            role="menuitem"
            className="tk-chip-option"
            onClick={(event) => pick(event.currentTarget.closest("details")!, option)}
          >
            {render(option)}
            {index < 9 ? <kbd className="tk-prop-key" aria-hidden>{index + 1}</kbd> : null}
          </button>
        ))}
      </div>
    </details>
  );
}

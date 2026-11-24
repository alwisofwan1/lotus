"use client";

import { TaskPriorityGlyph, TaskStatusGlyph } from "@/modules/tasks/components/TaskGlyphs";
import { closeDetailsOnEscape, useCloseMenusOnOutsidePress } from "@/modules/tasks/components/details-menu";
import {
  statusLabel,
  TASK_PRIORITY_ORDER,
  taskPriorityLabel,
  type StatusVocabulary,
} from "@/modules/tasks/services/task-vocabulary";
import type { BridgePriority, BridgeTaskStatus } from "@/modules/codespace/services/bridge/task-store";

/**
 * The mark a row already wears, turned into the control that changes it.
 *
 * No new affordance: the status circle and the priority bars are where someone looks to READ that
 * property, so they are where they will reach to change it. A separate "edit" button in every row
 * would be a fourth thing in a line that already has four.
 *
 * It is a `<details>`, like the filter chips, because the browser gives open/close for free.
 * Escape and outside-click it does not give — `details-menu.ts` adds both. The vocabulary comes from `task-vocabulary.ts`, the same list the filters read, so
 * there is never a status you can filter by but not set.
 */

type Kind = "status" | "priority";

export interface TaskPropertyMenuProps {
  kind: Kind;
  /** The words THIS row's project speaks — never a global list. */
  vocabulary: StatusVocabulary;
  value: string;
  /** A read-only list still draws its marks; it just does not offer to change them. */
  disabled?: boolean;
  /** Print the value's name beside its mark — the detail page's Properties column does. */
  showLabel?: boolean;
  onChange: (next: string) => void;
}

export function TaskPropertyMenu({
  kind,
  vocabulary,
  value,
  disabled,
  showLabel,
  onChange,
}: TaskPropertyMenuProps) {
  const options: readonly string[] = kind === "status" ? vocabulary.order : TASK_PRIORITY_ORDER;
  const label = (option: string) =>
    kind === "status"
      ? statusLabel(vocabulary, option)
      : taskPriorityLabel(option as BridgePriority);
  const glyph = (option: string, decorative = false) =>
    kind === "status" ? (
      <TaskStatusGlyph
        status={option as BridgeTaskStatus}
        vocabulary={vocabulary}
        decorative={decorative}
      />
    ) : (
      <TaskPriorityGlyph priority={option as BridgePriority} decorative={decorative} />
    );

  useCloseMenusOnOutsidePress();
  if (disabled) return glyph(value);

  return (
    <details
      data-menu
      data-kind={kind}
      className={showLabel ? "tk-prop tk-prop--labelled" : "tk-prop"}
      onToggle={(event) => {
        // Open → focus the current value, so the digit keys and Tab start from inside the menu.
        const details = event.currentTarget;
        if (details.open) details.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
      }}
      onKeyDown={(event) => {
        // 1…n picks the n-th option, the number each option wears.
        const index = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
        if (event.currentTarget.open && index >= 0 && index < options.length) {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.removeAttribute("open");
          event.currentTarget.querySelector("summary")?.focus();
          if (options[index] !== value) onChange(options[index]);
          return;
        }
        closeDetailsOnEscape(event);
      }}
    >
      <summary
        className="tk-prop-summary"
        aria-label={`${kind === "status" ? "Status" : "Priority"}: ${label(value)}`}
      >
        {glyph(value, true)}
        {showLabel ? <span className="tk-prop-label">{label(value)}</span> : null}
      </summary>
      <div className="tk-prop-menu" role="menu">
        {options.map((option, index) => (
          <button
            key={option}
            type="button"
            role="menuitemradio"
            aria-checked={option === value}
            className="tk-chip-option"
            onClick={(event) => {
              // Closing is the <details>' own job, and it does not do it for a click inside.
              event.currentTarget.closest("details")?.removeAttribute("open");
              if (option !== value) onChange(option);
            }}
          >
            {glyph(option, true)}
            <span>{label(option)}</span>
            {index < 9 ? <kbd className="tk-prop-key" aria-hidden>{index + 1}</kbd> : null}
          </button>
        ))}
      </div>
    </details>
  );
}

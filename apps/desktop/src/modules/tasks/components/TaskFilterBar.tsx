"use client";

import { useState, type Ref } from "react";
import { Check, ListFilter, Plus, Search, SlidersHorizontal } from "lucide-react";
import { FilterPropertyPicker, FilterRuleChip } from "@/modules/tasks/components/TaskFilterRules";
import { closeDetailsOnEscape, useCloseMenusOnOutsidePress } from "@/modules/tasks/components/details-menu";
import {
  defaultOperator,
  newRuleId,
  ruleIsActive,
  type FilterIdentity,
  type FilterOption,
  type FilterProperty,
  type TaskFilterRule,
} from "@/modules/tasks/services/task-filters";
import type { TaskSort } from "@/modules/tasks/services/task-list";

/**
 * The bar above the list: what is being hidden, in what order the rest is shown, and how many
 * survived.
 *
 * Two rows, as Notion draws them. The first is the view's tools — search, Filter, View (sort,
 * hide finished, refresh: one menu, so every order is visible before it is picked). The second exists only once a filter does: one chip per rule, `+ Filter` to add another,
 * and `Clear` at the end. A list nobody filtered carries no second row of chrome.
 *
 * Every menu is a `<details data-menu>`: the browser gives open/close and click-to-toggle for free,
 * `details-menu.ts` adds the outside press, and each menu answers its own Escape. Menus are
 * positioned absolutely so opening one does not push the list down.
 */

const SORT_LABEL: Record<TaskSort, string> = {
  priority: "Priority",
  recent: "Recently updated",
  number: "Task number",
  manual: "Manual",
};

const SORT_ORDER: TaskSort[] = ["priority", "recent", "number", "manual"];

export interface TaskFilterBarProps {
  /** This view's filters, in the order they were added. */
  rules: readonly TaskFilterRule[];
  onRulesChange: (rules: TaskFilterRule[]) => void;
  /** What "+ Filter" offers here. */
  properties: readonly FilterProperty[];
  /** What each property's menu lists in this view. */
  optionsFor: (property: FilterProperty) => FilterOption[];
  me: FilterIdentity | null;
  onSetMe: (me: FilterIdentity | null) => void;
  sort: TaskSort;
  onSortChange: (sort: TaskSort) => void;
  /** Free text over the title and the key. */
  query: string;
  onQueryChange: (query: string) => void;
  /** Held by the tracker so `/` can reach the box from anywhere in it. */
  searchRef?: Ref<HTMLInputElement>;
  hideDone: boolean;
  onHideDoneChange: (hide: boolean) => void;
  /** Re-read every source. Offered from the View menu. */
  onRefresh?: () => void;
}

export function TaskFilterBar({
  rules,
  onRulesChange,
  properties,
  optionsFor,
  me,
  onSetMe,
  sort,
  onSortChange,
  query,
  onQueryChange,
  searchRef,
  hideDone,
  onHideDoneChange,
  onRefresh,
}: TaskFilterBarProps) {
  useCloseMenusOnOutsidePress();
  /** The rule just added, which opens itself so its values are the next click. */
  const [fresh, setFresh] = useState<string | null>(null);
  const activeCount = rules.filter(ruleIsActive).length;

  const add = (property: FilterProperty) => {
    const rule: TaskFilterRule = { id: newRuleId(), property, operator: defaultOperator(property), values: [] };
    setFresh(rule.id);
    onRulesChange([...rules, rule]);
  };

  return (
    <div className="tk-filterbar">
    <div className="tk-filters">
      <label className="tk-search">
        <Search size={13} strokeWidth={1.75} aria-hidden />
        <input
          ref={searchRef}
          type="search"
          aria-label="Search tasks"
          placeholder="Search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            // One step per key, like everywhere else in the tracker: a query is cleared first, and
            // only an empty box lets go of focus. Neither closes the tracker.
            event.preventDefault();
            if (query) onQueryChange("");
            else event.currentTarget.blur();
          }}
        />
        {query ? null : <kbd className="tk-search-key" aria-hidden>/</kbd>}
      </label>

      <FilterPropertyPicker
        properties={properties}
        onPick={add}
        summaryLabel={activeCount ? `Filter, ${activeCount} active` : "Filter"}
        className={activeCount ? "tk-fr-picker--on" : undefined}
        summary={
          <>
            <ListFilter size={13} strokeWidth={1.75} aria-hidden />
            Filter
            {/* Rules that FILTER, not rules that exist: an unfinished chip hides nothing. */}
            {activeCount > 0 ? <span className="tk-chip-count">{activeCount}</span> : null}
          </>
        }
      />

      <details data-menu className="tk-chip tk-view" onKeyDown={closeDetailsOnEscape}>
        <summary aria-label={`View: sorted by ${SORT_LABEL[sort].toLowerCase()}${hideDone ? ", finished hidden" : ""}`}>
          <SlidersHorizontal size={13} strokeWidth={1.75} aria-hidden />
          View
        </summary>
        <div className="tk-chip-menu tk-view-menu" role="menu">
          <p className="tk-view-label">Sort by</p>
          {SORT_ORDER.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={option === sort}
              className="tk-chip-option"
              onClick={() => onSortChange(option)}
            >
              {SORT_LABEL[option]}
            </button>
          ))}
          <hr className="tk-view-rule" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={hideDone}
            className="tk-chip-option"
            onClick={() => onHideDoneChange(!hideDone)}
          >
            Hide finished
            <span className="tk-chip-check tk-view-check" aria-hidden>{hideDone ? <Check size={12} strokeWidth={2} /> : null}</span>
          </button>
          {onRefresh ? (
            <button
              type="button"
              role="menuitem"
              className="tk-chip-option"
              onClick={(event) => {
                event.currentTarget.closest("details")?.removeAttribute("open");
                onRefresh();
              }}
            >
              Refresh
            </button>
          ) : null}
        </div>
      </details>
    </div>

    {rules.length > 0 ? (
      <div className="tk-fr-row-bar" role="group" aria-label="Active filters">
        {rules.map((rule) => (
          <FilterRuleChip
            key={rule.id}
            rule={rule}
            options={optionsFor(rule.property)}
            me={me}
            autoOpen={rule.id === fresh}
            onChange={(next) => onRulesChange(rules.map((r) => (r.id === next.id ? next : r)))}
            onRemove={() => onRulesChange(rules.filter((r) => r.id !== rule.id))}
            onSetMe={onSetMe}
          />
        ))}
        <FilterPropertyPicker
          properties={properties}
          onPick={add}
          summaryLabel="Add filter"
          className="tk-fr-add"
          summary={
            <>
              <Plus size={12} strokeWidth={2} aria-hidden />
              Filter
            </>
          }
        />
        <button type="button" className="tk-fr-reset" onClick={() => onRulesChange([])}>
          Clear
        </button>
      </div>
    ) : null}
    </div>
  );
}

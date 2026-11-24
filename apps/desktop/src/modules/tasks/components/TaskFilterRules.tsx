"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, CircleDot, Folder, MoreHorizontal, Search, SignalHigh, Tag, Trash2, User, UserRound, X } from "lucide-react";
import { TaskStatusGlyph } from "@/modules/tasks/components/TaskGlyphs";
import { useCloseMenusOnOutsidePress } from "@/modules/tasks/components/details-menu";
import {
  ME,
  OPERATOR_LABEL,
  PROPERTY_LABEL,
  operatorTakesValues,
  operatorsFor,
  ruleIsActive,
  ruleSummary,
  type FilterIdentity,
  type FilterOperator,
  type FilterOption,
  type FilterProperty,
  type TaskFilterRule,
} from "@/modules/tasks/services/task-filters";
import type { BridgeTaskStatus } from "@/modules/codespace/services/bridge/task-store";

/**
 * Notion's filter chips: one per rule, each opening onto its property, its operator and its values,
 * with the values chosen as tokens in a search box and the rest one keystroke away.
 *
 * `<details data-menu>` like every other menu in the tracker, so one menu is open at a time and a
 * press outside closes it (`details-menu.ts`). Escape is answered here, one step per key: an open
 * operator list first, then the popover — never the tracker behind it.
 */

export const PROPERTY_ICON: Record<FilterProperty, typeof User> = {
  status: CircleDot,
  assignee: User,
  label: Tag,
  priority: SignalHigh,
  project: Folder,
};

/** Opens a `<details>` from code — the newly added rule, so choosing its values is the next click. */
function useOpenOnMount(ref: React.RefObject<HTMLDetailsElement | null>, open: boolean | undefined) {
  useEffect(() => {
    if (!open || !ref.current) return;
    ref.current.open = true;
  }, [open, ref]);
}

function escapeCloses(event: KeyboardEvent<HTMLDetailsElement>) {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  const details = event.currentTarget;
  if (!details.open) return;
  event.preventDefault();
  details.open = false;
  details.querySelector("summary")?.focus();
}

/** The avatar people wear here: their initial, as the ticket page draws them. */
function Avatar({ name, me }: { name: string; me?: boolean }) {
  return (
    <span className="tk-fr-avatar" data-me={me || undefined} aria-hidden>
      {me ? <UserRound size={11} strokeWidth={2} /> : (name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

function OptionMark({ property, option }: { property: FilterProperty; option: FilterOption }) {
  if (property === "status" && option.vocabulary) {
    return <TaskStatusGlyph status={option.value as BridgeTaskStatus} vocabulary={option.vocabulary} size={13} decorative />;
  }
  if (property === "assignee") return <Avatar name={option.label} />;
  if (property === "project") {
    return <span className="tk-fr-dot" style={option.color ? { background: option.color } : undefined} aria-hidden />;
  }
  if (property === "label") return <Tag size={12} strokeWidth={1.75} aria-hidden />;
  return null;
}

// ── "+ Filter" ──────────────────────────────────────────────────────────────

export function FilterPropertyPicker({
  properties,
  onPick,
  summary,
  summaryLabel,
  className,
}: {
  properties: readonly FilterProperty[];
  onPick: (property: FilterProperty) => void;
  summary: ReactNode;
  summaryLabel: string;
  className?: string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  useCloseMenusOnOutsidePress();

  const listed = properties.filter((p) => PROPERTY_LABEL[p].toLowerCase().includes(query.trim().toLowerCase()));

  const pick = (property: FilterProperty) => {
    if (ref.current) ref.current.open = false;
    setQuery("");
    onPick(property);
  };

  return (
    <details
      ref={ref}
      data-menu
      className={`tk-chip tk-fr-picker ${className ?? ""}`}
      onKeyDown={escapeCloses}
      onToggle={() => {
        if (!ref.current?.open) return;
        setActive(0);
        requestAnimationFrame(() => inputRef.current?.focus());
      }}
    >
      <summary aria-label={summaryLabel}>{summary}</summary>
      <div className="tk-chip-menu tk-fr-menu" role="group" aria-label="Filter by property">
        <label className="tk-fr-search">
          <Search size={12} strokeWidth={1.75} aria-hidden />
          <input
            ref={inputRef}
            aria-label="Filter by…"
            placeholder="Filter by…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActive((index) => (listed.length ? (index + step + listed.length) % listed.length : 0));
              } else if (event.key === "Enter" && listed[active]) {
                event.preventDefault();
                pick(listed[active]);
              }
            }}
          />
        </label>
        {listed.map((property, index) => {
          const Icon = PROPERTY_ICON[property];
          return (
            <button
              key={property}
              type="button"
              className="tk-chip-option tk-fr-option"
              data-active={index === active || undefined}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(property)}
            >
              <Icon size={13} strokeWidth={1.75} aria-hidden />
              {PROPERTY_LABEL[property]}
            </button>
          );
        })}
        {listed.length === 0 ? <p className="tk-fr-empty">No property matches.</p> : null}
      </div>
    </details>
  );
}

// ── One rule ────────────────────────────────────────────────────────────────

export interface FilterRuleChipProps {
  rule: TaskFilterRule;
  options: readonly FilterOption[];
  me: FilterIdentity | null;
  /** The rule was just added: open it, so its values are the next thing chosen. */
  autoOpen?: boolean;
  onChange: (rule: TaskFilterRule) => void;
  onRemove: () => void;
  onSetMe: (me: FilterIdentity | null) => void;
}

export function FilterRuleChip({ rule, options, me, autoOpen, onChange, onRemove, onSetMe }: FilterRuleChipProps) {
  const ref = useRef<HTMLDetailsElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  /** Which inner list is showing: the values, the operators, the "…" menu, or "which one is you?". */
  const [pane, setPane] = useState<"values" | "operators" | "more" | "who">("values");
  useCloseMenusOnOutsidePress();
  useOpenOnMount(ref, autoOpen);

  const isPeople = rule.property === "assignee";
  const labelOf = (value: string) =>
    value === ME ? "Me" : (options.find((option) => option.value === value)?.label ?? value) || "Unnamed";

  // Me first (for people), then the chosen, then the rest — filtered by what was typed.
  const listed = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows: FilterOption[] = [];
    if (isPeople) rows.push({ value: ME, label: "Me", count: me ? (options.find((o) => o.value === me.id)?.count ?? 0) : 0 });
    rows.push(...options);
    return rows.filter((option) => !needle || option.label.toLowerCase().includes(needle) || (option.value === ME && me?.name.toLowerCase().includes(needle)));
  }, [isPeople, me, options, query]);

  const toggleValue = (value: string) => {
    if (value === ME && !me) {
      setPane("who");
      setQuery("");
      return;
    }
    const values = rule.values.includes(value) ? rule.values.filter((v) => v !== value) : [...rule.values, value];
    // A value picked under "is empty" means the person wants values: back to the default operator.
    const operator = operatorTakesValues(rule.operator) ? rule.operator : operatorsFor(rule.property)[0];
    onChange({ ...rule, operator, values });
    setQuery("");
    inputRef.current?.focus();
  };

  const setOperator = (operator: FilterOperator) => {
    onChange({ ...rule, operator, values: operatorTakesValues(operator) ? rule.values : [] });
    setPane("values");
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => (listed.length ? (index + step + listed.length) % listed.length : 0));
    } else if (event.key === "Enter" && listed[active]) {
      event.preventDefault();
      toggleValue(listed[active].value);
    } else if (event.key === "Backspace" && !query && rule.values.length > 0) {
      // A token box, so Backspace in an empty box takes the last token — as Notion's does.
      event.preventDefault();
      onChange({ ...rule, values: rule.values.slice(0, -1) });
    }
  };

  const summary = ruleSummary(rule, labelOf);
  const on = ruleIsActive(rule);
  const Icon = PROPERTY_ICON[rule.property];
  const takesValues = operatorTakesValues(rule.operator);

  return (
    <details
      ref={ref}
      data-menu
      className="tk-chip tk-fr-chip"
      data-on={on || undefined}
      onKeyDown={(event) => {
        if (event.key === "Escape" && pane !== "values") {
          event.preventDefault();
          setPane("values");
          return;
        }
        escapeCloses(event);
      }}
      onToggle={() => {
        if (!ref.current?.open) {
          setPane("values");
          setQuery("");
          return;
        }
        setActive(0);
        requestAnimationFrame(() => inputRef.current?.focus());
      }}
    >
      <summary
        aria-label={summary.detail ? `${summary.property}: ${summary.detail}` : `${summary.property} filter, not set`}
        title={summary.detail ? `${summary.property}: ${summary.detail}` : undefined}
      >
        <Icon size={12} strokeWidth={1.9} aria-hidden />
        <span className="tk-fr-chip-text">
          <span className="tk-fr-chip-prop">{summary.property}</span>
          {summary.detail ? <span className="tk-fr-chip-detail">: {summary.detail}</span> : null}
        </span>
        <ChevronDown size={12} strokeWidth={1.9} aria-hidden className="tk-fr-caret" />
      </summary>

      <div className="tk-chip-menu tk-fr-menu tk-fr-rule" role="group" aria-label={`Filter by ${PROPERTY_LABEL[rule.property].toLowerCase()}`}>
        <div className="tk-fr-head">
          <span className="tk-fr-head-prop">{PROPERTY_LABEL[rule.property]}</span>
          <button
            type="button"
            className="tk-fr-operator"
            aria-haspopup="listbox"
            aria-expanded={pane === "operators"}
            onClick={() => setPane(pane === "operators" ? "values" : "operators")}
          >
            {OPERATOR_LABEL[rule.operator]}
            <ChevronDown size={11} strokeWidth={2} aria-hidden />
          </button>
          <button
            type="button"
            className="tk-fr-icon"
            aria-label="Filter actions"
            aria-expanded={pane === "more"}
            onClick={() => setPane(pane === "more" ? "values" : "more")}
          >
            <MoreHorizontal size={14} strokeWidth={1.75} />
          </button>
        </div>

        {pane === "operators" ? (
          <div className="tk-fr-list" role="listbox" aria-label="Condition">
            {operatorsFor(rule.property).map((operator) => (
              <button
                key={operator}
                type="button"
                role="option"
                aria-selected={operator === rule.operator}
                className="tk-chip-option tk-fr-option"
                onClick={() => setOperator(operator)}
              >
                <span className="tk-chip-check">{operator === rule.operator ? <Check size={12} strokeWidth={2.5} /> : null}</span>
                {OPERATOR_LABEL[operator]}
              </button>
            ))}
          </div>
        ) : pane === "more" ? (
          <div className="tk-fr-list">
            {isPeople && me ? (
              <button type="button" className="tk-chip-option tk-fr-option" onClick={() => setPane("who")}>
                <UserRound size={13} strokeWidth={1.75} aria-hidden />
                Change who “Me” is
                <span className="tk-fr-meta">{me.name}</span>
              </button>
            ) : null}
            <button type="button" className="tk-chip-option tk-fr-option tk-fr-danger" onClick={onRemove}>
              <Trash2 size={13} strokeWidth={1.75} aria-hidden />
              Delete filter
            </button>
          </div>
        ) : pane === "who" ? (
          <div className="tk-fr-list" role="group" aria-label="Which one is you?">
            <p className="tk-fr-hint">
              Which one is you? Lotus reads Notion as an integration, so it cannot tell on its own. Asked once.
            </p>
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                className="tk-chip-option tk-fr-option"
                onClick={() => {
                  onSetMe({ id: option.value, name: option.label });
                  if (!rule.values.includes(ME)) onChange({ ...rule, operator: takesValues ? rule.operator : "contains", values: [...rule.values, ME] });
                  setPane("values");
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}
              >
                <Avatar name={option.label} />
                {option.label || "Unnamed"}
                {me?.id === option.value ? <Check size={12} strokeWidth={2.5} className="tk-fr-tick" aria-hidden /> : null}
              </button>
            ))}
            {options.length === 0 ? <p className="tk-fr-empty">Nobody is assigned to anything here yet.</p> : null}
          </div>
        ) : takesValues ? (
          <>
            <div className="tk-fr-tokens" onClick={() => inputRef.current?.focus()}>
              {rule.values.map((value) => (
                <span key={value} className="tk-fr-token">
                  {isPeople ? <Avatar name={value === ME ? "Me" : labelOf(value)} me={value === ME} /> : null}
                  <span className="tk-fr-token-text">{labelOf(value)}</span>
                  <button
                    type="button"
                    className="tk-fr-token-x"
                    aria-label={`Remove ${labelOf(value)}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onChange({ ...rule, values: rule.values.filter((v) => v !== value) });
                    }}
                  >
                    <X size={10} strokeWidth={2.25} />
                  </button>
                </span>
              ))}
              <input
                ref={inputRef}
                className="tk-fr-input"
                aria-label={`Search ${PROPERTY_LABEL[rule.property].toLowerCase()}`}
                placeholder={rule.values.length ? "" : `Select ${isPeople ? "people" : "options"}…`}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={onInputKey}
              />
              {rule.values.length > 0 ? (
                <button
                  type="button"
                  className="tk-fr-clear"
                  aria-label="Clear values"
                  onClick={(event) => {
                    event.stopPropagation();
                    onChange({ ...rule, values: [] });
                    inputRef.current?.focus();
                  }}
                >
                  <X size={10} strokeWidth={2.5} />
                </button>
              ) : null}
            </div>
            <div className="tk-fr-list">
              {listed.map((option, index) => {
                const chosen = rule.values.includes(option.value);
                const groupStart = option.group && option.group !== listed[index - 1]?.group;
                return (
                  <div key={option.value} className="tk-fr-row">
                    {groupStart ? <p className="tk-fr-group">{option.group}</p> : null}
                    <button
                      type="button"
                      className="tk-chip-option tk-fr-option"
                      aria-pressed={chosen}
                      data-active={index === active || undefined}
                      data-me-row={option.value === ME || undefined}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => toggleValue(option.value)}
                    >
                      {option.value === ME ? <Avatar name="Me" me /> : <OptionMark property={rule.property} option={option} />}
                      <span className="tk-fr-option-text">
                        {option.label || "Unnamed"}
                        {option.value === ME ? (
                          <span className="tk-fr-meta">{me ? me.name : "Choose who you are"}</span>
                        ) : null}
                      </span>
                      {option.value !== ME ? <span className="tk-fr-count">{option.count}</span> : null}
                      <span className="tk-fr-tick">{chosen ? <Check size={12} strokeWidth={2.5} /> : null}</span>
                    </button>
                  </div>
                );
              })}
              {listed.length === 0 ? <p className="tk-fr-empty">No option matches “{query}”.</p> : null}
            </div>
          </>
        ) : (
          <p className="tk-fr-hint">Shows tasks whose {PROPERTY_LABEL[rule.property].toLowerCase()} {OPERATOR_LABEL[rule.operator]}.</p>
        )}
      </div>
    </details>
  );
}

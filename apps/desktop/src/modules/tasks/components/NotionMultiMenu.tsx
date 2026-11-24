"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, Plus, Search } from "lucide-react";
import { useCloseMenusOnOutsidePress } from "@/modules/tasks/components/details-menu";

/**
 * A ticket's people or labels in a Manage database (task "Ticket Sources 09"): what is set, and the
 * rest one search away.
 *
 * The column shows only what the ticket carries — a board of seventeen people drawn as seventeen
 * chips buried the two that were assigned. Opening it lists everyone, the chosen first, filtered as
 * you type. Picks are gathered while it is open and written ONCE when it closes: each write is a
 * read and a PATCH at Notion, and a second click while the first is out would be refused.
 *
 * A `<details data-menu>`, like `TaskPropertyMenu`: open/close from the browser, Escape and outside-click
 * from `details-menu.ts`.
 */

export interface MultiChoice {
  id: string;
  /** Empty when Notion sent no name — a partial user object, which the API allows. */
  name: string;
}

const UNNAMED = "Unnamed user";

export function NotionMultiMenu({
  label,
  noun,
  choices,
  chosen,
  disabled,
  kind,
  onChange,
}: {
  label: string;
  /** "person", "label" — for the search box and the empty line. */
  noun: string;
  choices: readonly MultiChoice[];
  /** Ids, in the ticket's order. */
  chosen: readonly string[];
  disabled: boolean;
  kind: "people" | "labels";
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([...chosen]);
  const [query, setQuery] = useState("");
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useCloseMenusOnOutsidePress();

  const nameOf = (id: string) => {
    const name = choices.find((c) => c.id === id)?.name ?? "";
    return name && name !== id ? name : kind === "people" ? UNNAMED : id;
  };

  // Chosen first, in the ticket's order; then the rest by name. Filtered by the search.
  const listed = useMemo(() => {
    const byName = (a: MultiChoice, b: MultiChoice) => nameOf(a.id).localeCompare(nameOf(b.id));
    const first = picked.map((id) => choices.find((c) => c.id === id) ?? { id, name: "" });
    const rest = choices.filter((c) => !picked.includes(c.id)).sort(byName);
    const needle = query.trim().toLowerCase();
    return [...first, ...rest].filter((c) => !needle || nameOf(c.id).toLowerCase().includes(needle));
    // `nameOf` reads `choices`, already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choices, picked, query]);

  const onToggle = () => {
    const nowOpen = Boolean(detailsRef.current?.open);
    if (nowOpen === open) return;
    setOpen(nowOpen);
    if (nowOpen) {
      // Every opening starts from what the ticket has now.
      setPicked([...chosen]);
      setQuery("");
      return;
    }
    const same = picked.length === chosen.length && picked.every((id, i) => id === chosen[i]);
    if (!same) onChange(picked);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key !== "Escape" || !detailsRef.current?.open) return;
    // Handled here so the tracker's own Escape does not close the panel (see details-menu.ts).
    event.preventDefault();
    detailsRef.current.open = false;
    detailsRef.current.querySelector("summary")?.focus();
  };

  const shown = open ? picked : chosen;

  return (
    <div role="group" aria-label={label} className="tk-multi">
      <details ref={detailsRef} data-menu className="tk-prop tk-prop--labelled tk-multi-menu" onToggle={onToggle} onKeyDown={onKeyDown}>
        <summary
          className="tk-prop-summary tk-multi-summary"
          aria-label={shown.length ? `${label}: ${shown.map(nameOf).join(", ")}` : `Add ${noun}`}
          aria-disabled={disabled || undefined}
          onClick={(event) => {
            if (disabled) event.preventDefault();
          }}
        >
          {shown.length === 0 ? (
            <span className="tk-multi-empty">
              <Plus size={13} strokeWidth={2} aria-hidden />
              Add {noun}
            </span>
          ) : kind === "people" ? (
            <span className="tk-multi-people">
              {shown.map((id) => (
                <span key={id} className="tk-multi-person" data-unnamed={nameOf(id) === UNNAMED || undefined}>
                  <span className="tk-multi-avatar" aria-hidden>
                    {initial(nameOf(id))}
                  </span>
                  {nameOf(id)}
                </span>
              ))}
            </span>
          ) : (
            <span className="tk-multi-labels">
              {shown.map((id) => (
                <span key={id} className="tk-multi-label">
                  {nameOf(id)}
                </span>
              ))}
            </span>
          )}
        </summary>

        <div className="tk-prop-menu tk-multi-list" role="menu" aria-label={label}>
          <label className="tk-multi-search">
            <Search size={13} strokeWidth={1.75} aria-hidden />
            <input
              type="search"
              aria-label={`Find a ${noun}`}
              placeholder={`Find a ${noun}`}
              value={query}
              autoFocus
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="tk-multi-options">
            {listed.length === 0 ? <p className="tk-multi-none">No {noun} matches.</p> : null}
            {listed.map((choice) => {
              const on = picked.includes(choice.id);
              return (
                <button
                  key={choice.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  className="tk-chip-option"
                  onClick={() => setPicked((now) => (on ? now.filter((id) => id !== choice.id) : [...now, choice.id]))}
                >
                  <span className="tk-chip-check">{on ? <Check size={12} strokeWidth={2.5} /> : null}</span>
                  {kind === "people" ? (
                    <span className="tk-multi-avatar" aria-hidden>
                      {initial(nameOf(choice.id))}
                    </span>
                  ) : null}
                  <span className="tk-multi-name">{nameOf(choice.id)}</span>
                </button>
              );
            })}
          </div>
          <p className="tk-multi-foot">Saved to Notion when this closes</p>
        </div>
      </details>
    </div>
  );
}

function initial(name: string): string {
  return name === UNNAMED ? "?" : (name.trim()[0] ?? "?").toUpperCase();
}

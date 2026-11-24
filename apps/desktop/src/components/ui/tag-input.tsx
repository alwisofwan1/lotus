"use client";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** Must match the `.ui-chip[data-leaving]` transition in styles/ui-kit.css. */
const LEAVE_MS = 150;

interface TagInputProps {
  /** Unique strings; each is a chip (and its React key). */
  values: readonly string[];
  /** Accessible name of the "add" field. */
  label: string;
  placeholder?: string;
  /** Typed (Enter) or pasted text, raw: the caller splits and validates. Omit for a read-only list. */
  onAdd?: (raw: string) => void;
  /** A chip was edited in place (Enter or blur). Omit to make chips not editable. */
  onReplace?: (index: number, raw: string) => void;
  onRemove?: (index: number) => void;
  /** Bump to shake the field (a rejected value). */
  shake?: number;
}

/**
 * A list of strings as chips: add, paste a list, click a chip to edit it, remove. Validation stays
 * with the caller, so the same field serves names, labels or hosts. Skin: `.ui-chips` in ui-kit.css.
 */
export function TagInput({ values, label, placeholder, onAdd, onReplace, onRemove, shake }: TagInputProps) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  // A DOM attribute, not state: the shake is pure decoration and must not re-render the chips.
  useEffect(() => {
    const el = box.current;
    if (!shake || !el) return;
    el.dataset.shake = "";
    const timer = setTimeout(() => delete el.dataset.shake, 320);
    return () => clearTimeout(timer);
  }, [shake]);

  const remove = (index: number) => {
    setLeaving(values[index]);
    setTimeout(() => {
      setLeaving(null);
      onRemove?.(index);
    }, LEAVE_MS);
  };

  return (
    <div ref={box} className="ui-chips">
      {values.map((value, i) =>
        editing === i && onReplace ? (
          <input
            key={`edit:${value}`}
            className="ui-chip"
            data-editing=""
            aria-label={`Change ${value}`}
            defaultValue={value}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setEditing(null);
            }}
            onBlur={(e) => {
              if (editing !== i) return;
              setEditing(null);
              onReplace(i, e.currentTarget.value);
            }}
          />
        ) : (
          <span key={value} className="ui-chip" data-leaving={leaving === value ? "" : undefined} data-static={onRemove ? undefined : ""}>
            {onReplace ? (
              <button type="button" className="ui-chip-text" title="Click to change" onClick={() => setEditing(i)}>
                {value}
              </button>
            ) : (
              <span>{value}</span>
            )}
            {onRemove ? (
              <button type="button" className="ui-chip-x" aria-label={`Remove ${value}`} onClick={() => remove(i)}>
                <X size={11} />
              </button>
            ) : null}
          </span>
        ),
      )}
      {onAdd ? (
        <input
          className="ui-chips-input"
          aria-label={label}
          placeholder={placeholder}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !draft.trim()) return;
            e.preventDefault();
            onAdd(draft);
            setDraft("");
          }}
          onPaste={(e) => {
            e.preventDefault();
            onAdd(e.clipboardData.getData("text"));
          }}
        />
      ) : null}
    </div>
  );
}

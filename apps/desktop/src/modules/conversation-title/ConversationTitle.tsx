"use client";

import "@/styles/conversation-title.css";

import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { Dither } from "@/modules/chat/ui/Dither";
import { MAX_TITLE_CHARS, displayTitle, renameRequest, titleSourceLabel, type TitleSource } from "./domain";

export interface ConversationTitleProps {
  /** The stored title; empty while the conversation has none. */
  title: string;
  /** Drawn, muted, while there is no title. */
  placeholder?: string;
  /** Where the title came from. Unknown = no source line, and "use automatic" is always offered. */
  source?: TitleSource;
  /** A model is naming it right now (the caller's own run, e.g. Chat's first title). */
  generating?: boolean;
  /** `""` hands the title back to the automatic one. */
  onRename: (title: string) => void;
  /** Asks for a fresh automatic title. Omitted = the surface has no titler, and no menu row. */
  onRegenerate?: () => Promise<unknown>;
  /** Read-only: shown, never edited (an archived chat). */
  readOnly?: boolean;
  className?: string;
}

// Dither fields (mockups/conversation-title-dither.html), module constants so they draw once.
/** The menu's corner, as Chat's thread menu. */
const corner = (u: number, v: number) => Math.max(0, u - 0.35) * (1 - v) * 0.9;
/** The rename underline: an even checker that fades out over the last fifth, as Chat's rail. */
const band = (u: number) => (u < 0.8 ? 0.5 : (0.5 * (1 - u)) / 0.2);
/** One bright patch on a faint floor; CSS slides it along while a model names the title. */
const crawl = (u: number) => 0.18 + Math.max(0, 0.7 - Math.abs(u - 0.25) * 2.4);
const solid = () => 1;

type Action = "rename" | "regenerate" | "automatic" | "copy";

/**
 * One conversation title for Code, Chat and Canvas: double-click (or F2 on it) to rename, the
 * chevron for a menu in Chat's thread-menu language — the title on top, keys instead of icons.
 *
 * Clicking away CANCELS a rename, as Chat's rail always did: nothing is renamed by accident.
 * `nodrag nopan` keep a Canvas node from being dragged or the board from panning while the
 * title is used; elsewhere they are inert class names.
 */
export function ConversationTitle({
  title,
  placeholder = "New conversation",
  source,
  generating,
  onRename,
  onRegenerate,
  readOnly,
  className,
}: ConversationTitleProps) {
  const [editing, setEditing] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const shown = title.trim() ? displayTitle(title) : placeholder;
  const busy = generating || regenerating;
  // An automatic title has nothing to go back to; unknown (Chat) may be either, so it is offered.
  const canReset = source === undefined || source === "manual";

  // A `<details>` menu stays open on an outside click; this closes it like every other menu here.
  useEffect(() => {
    const close = (event: PointerEvent) => {
      const open = menu.current;
      if (open?.open && !open.contains(event.target as Node)) open.open = false;
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, []);

  const finish = (draft: string | null) => {
    setEditing(false);
    if (draft === null) return;
    const next = renameRequest(draft, title);
    if (next !== null) onRename(next);
  };

  const act = (action: Action) => {
    if (menu.current) menu.current.open = false;
    if (action === "rename") setEditing(true);
    else if (action === "automatic") onRename("");
    else if (action === "copy") void copyTextToClipboard(shown).catch(() => {});
    else if (onRegenerate && !busy) {
      setRegenerating(true);
      // Silent on failure: the title on screen stays, which is the right fallback for a name.
      void onRegenerate()
        .catch((error: unknown) => console.warn("[conversation-title] regenerate failed:", error))
        .finally(() => setRegenerating(false));
    }
  };

  const rows: { action: Action; label: string; keycap: string; disabled?: boolean }[] = [
    { action: "rename", label: "Rename", keycap: "R" },
    ...(onRegenerate ? [{ action: "regenerate" as const, label: busy ? "Regenerating…" : "Regenerate", keycap: "T", disabled: busy }] : []),
    ...(canReset ? [{ action: "automatic" as const, label: "Use automatic title", keycap: "A" }] : []),
    { action: "copy", label: "Copy title", keycap: "C", disabled: !title.trim() },
  ];

  // Chat's menu keys: a letter acts, arrows move, Esc closes.
  const onMenuKey = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (!menu.current?.open) return;
    event.stopPropagation();
    const key = event.key.toLowerCase();
    const items = [...menu.current.querySelectorAll<HTMLButtonElement>(".conversation-title-item:not(:disabled)")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const row = rows.find((r) => r.keycap.toLowerCase() === key && !r.disabled);
    if (key === "escape") {
      menu.current.open = false;
      menu.current.querySelector("summary")?.focus();
    } else if (key === "arrowdown") items[(at + 1) % items.length]?.focus();
    else if (key === "arrowup") items[(at - 1 + items.length) % items.length]?.focus();
    else if (row) act(row.action);
    else return;
    event.preventDefault();
  };

  if (editing) {
    return (
      <span className={cn("conversation-title nodrag nopan", className)} data-editing="true">
        <span className="conversation-title-field">
          <input
            className="conversation-title-input"
            aria-label="Conversation title"
            defaultValue={title}
            placeholder="Empty = automatic title"
            maxLength={MAX_TITLE_CHARS}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              // Keystrokes belong to the field, never to a pane or canvas shortcut.
              event.stopPropagation();
              if (event.key === "Enter") finish(event.currentTarget.value);
              else if (event.key === "Escape") finish(null);
              else return;
              event.preventDefault();
            }}
            onBlur={() => finish(null)}
            onDoubleClick={(event) => event.stopPropagation()}
          />
          <Dither className="conversation-title-line" field={band} cell={1} />
        </span>
        <span className="conversation-title-hint" aria-hidden>
          <kbd>↵</kbd> save <kbd>esc</kbd> cancel · empty = automatic
        </span>
      </span>
    );
  }

  return (
    <span
      className={cn("conversation-title nodrag nopan", className)}
      data-status={busy ? "generating" : !title.trim() || source === "prompt" ? "pending" : "ready"}
      data-source={source}
    >
      <span
        className="conversation-title-text"
        title={readOnly ? title || undefined : `${title || placeholder} — double-click to rename`}
        tabIndex={readOnly ? undefined : 0}
        onDoubleClick={(event) => {
          if (readOnly) return;
          event.stopPropagation();
          setEditing(true);
        }}
        onKeyDown={(event) => {
          if (readOnly || event.key !== "F2") return;
          event.preventDefault();
          setEditing(true);
        }}
      >
        {shown}
      </span>
      {source === "manual" ? (
        <span className="conversation-title-mark" role="img" aria-label="Renamed by you">
          <Dither field={solid} cell={1} />
        </span>
      ) : null}
      {busy ? (
        <span className="conversation-title-crawl" aria-hidden>
          <Dither field={crawl} cell={1} />
        </span>
      ) : null}
      {readOnly ? null : (
        <details ref={menu} className="conversation-title-menu" onKeyDown={onMenuKey}>
          <summary className="conversation-title-trigger" aria-label="Title actions" title="Title actions">
            <ChevronDown size={11} strokeWidth={2} aria-hidden />
          </summary>
          <div className="conversation-title-pop" role="menu">
            <Dither className="conversation-title-corner" field={corner} />
            <div className="conversation-title-head">
              <span className="conversation-title-head-title">{shown}</span>
              {source ? (
                <span className="conversation-title-head-sub">
                  {source === "manual" ? <Dither className="conversation-title-head-mark" field={solid} cell={1} /> : null}
                  {titleSourceLabel(source)}
                </span>
              ) : null}
            </div>
            {rows.map((row) => (
              <button
                key={row.action}
                type="button"
                role="menuitem"
                className="conversation-title-item"
                disabled={row.disabled}
                onClick={() => act(row.action)}
              >
                {row.label}
                <kbd>{row.keycap}</kbd>
              </button>
            ))}
          </div>
        </details>
      )}
    </span>
  );
}

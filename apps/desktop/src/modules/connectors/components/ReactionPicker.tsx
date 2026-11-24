"use client";

import { RefreshCw, Smile } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { SlackEmoji, SlackEmojiView } from "../services/connectors-api";
import type { EmojiCatalog } from "../services/emoji-catalog";
import { emojiName, lookupEmoji } from "../services/status-reactions";

/** The columns of the emoji grid; up and down move by this many. */
const COLUMNS = 8;

type Choice = { name: string; glyph?: string; url?: string; label: string };
type Section = { title: string; choices: Choice[] };

/** One emoji: its glyph, or the custom emoji's image, or `:name:` before either is known. */
export function EmojiMark({ text, catalog, custom }: { text: string; catalog: EmojiCatalog | null; custom: SlackEmojiView | null }) {
  const name = emojiName(text);
  if (!name) return <>—</>;
  const found = lookupEmoji(name, catalog, custom);
  // eslint-disable-next-line @next/next/no-img-element -- a Slack CDN image, not a build asset
  if (found.url) return <img className="cn-emoji-img" src={found.url} alt={`:${name}:`} />;
  return <>{found.glyph ?? `:${name}:`}</>;
}

function customChoice(e: SlackEmoji, catalog: EmojiCatalog | null): Choice {
  const glyph = e.aliasOf ? catalog?.glyphs.get(e.aliasOf) : undefined;
  return { name: e.name, url: e.url ?? undefined, glyph, label: e.name };
}

/** The sections to show for `query`: the workspace's emoji first, then the standard ones by category. */
export function pickerSections(query: string, catalog: EmojiCatalog | null, custom: SlackEmojiView | null): Section[] {
  const q = emojiName(query);
  const matches = (names: string[]) => !q || names.some((n) => n.includes(q));
  const sections: Section[] = [];
  const own = (custom?.emoji ?? []).filter((e) => matches([e.name])).map((e) => customChoice(e, catalog));
  if (own.length) sections.push({ title: "Workspace", choices: own });
  if (catalog) {
    catalog.categories.forEach((title, category) => {
      const choices = catalog.emoji
        .filter((e) => e.category === category && matches(e.names))
        .map((e) => ({ name: e.name, glyph: e.glyph, label: e.names.join(", ") }));
      if (choices.length) sections.push({ title, choices });
    });
  }
  return sections;
}

/**
 * The popover body of a reaction field: a search box over the workspace's emoji and the standard ones.
 * Focus stays in the search box; the arrow keys move the highlighted emoji (`aria-activedescendant`),
 * Enter picks it, Escape closes.
 */
export function EmojiPanel({
  catalog,
  custom,
  loadingCustom,
  onRefresh,
  onPick,
  onClose,
}: {
  catalog: EmojiCatalog | null;
  custom: SlackEmojiView | null;
  loadingCustom: boolean;
  onRefresh: () => void;
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);

  useEffect(() => search.current?.focus(), []);

  const sections = useMemo(() => pickerSections(query, catalog, custom), [query, catalog, custom]);
  const flat = useMemo(() => sections.flatMap((s) => s.choices), [sections]);
  // Where each section starts in `flat`, to number its options.
  const starts = useMemo(() => sections.map((_, n) => sections.slice(0, n).reduce((sum, s) => sum + s.choices.length, 0)), [sections]);
  const current = Math.min(active, Math.max(flat.length - 1, 0));
  const optionId = (i: number) => `${id}-${i}`;

  useEffect(() => {
    grid.current?.querySelector(`[id="${id}-${current}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [current, id]);

  const onKeyDown = (event: KeyboardEvent) => {
    const move = (by: number) => {
      event.preventDefault();
      setActive(Math.min(Math.max(current + by, 0), flat.length - 1));
    };
    if (event.key === "ArrowRight") move(1);
    else if (event.key === "ArrowLeft") move(-1);
    else if (event.key === "ArrowDown") move(COLUMNS);
    else if (event.key === "ArrowUp") move(-COLUMNS);
    else if (event.key === "Enter") {
      event.preventDefault();
      const choice = flat[current];
      if (choice) onPick(choice.name);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="cn-emoji-panel" onKeyDown={onKeyDown}>
      <div className="cn-emoji-bar">
        <input
          ref={search}
          className="au-input"
          type="search"
          role="combobox"
          aria-label="Search emoji"
          aria-expanded
          aria-controls={`${id}-list`}
          aria-activedescendant={flat.length ? optionId(current) : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search by name"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        <button
          type="button"
          className="rs-button rs-button--ghost"
          onClick={onRefresh}
          disabled={loadingCustom}
          aria-label="Refresh workspace emoji"
          title="Refresh workspace emoji"
        >
          <RefreshCw size={13} aria-hidden className={loadingCustom ? "cn-spin" : undefined} />
        </button>
      </div>
      {custom?.state === "missing_scope" ? (
        <p className="cn-emoji-note" role="status">
          Reconnect Slack to allow emoji:read. Add it under OAuth &amp; Permissions → User Token Scopes (not Bot
          Token Scopes), then Install App → Reinstall to Workspace. Standard emoji work meanwhile.
        </p>
      ) : null}
      <div ref={grid} id={`${id}-list`} className="cn-emoji-list" role="listbox" aria-label="Emoji">
        {!catalog ? <p className="cn-emoji-note">Loading emoji…</p> : null}
        {catalog && flat.length === 0 ? <p className="cn-emoji-note">No emoji matches “{query.trim()}”.</p> : null}
        {sections.map((section, n) => (
          <div key={section.title} role="group" aria-label={section.title}>
            <div className="cn-emoji-title" aria-hidden>
              {section.title}
            </div>
            <div className="cn-emoji-grid">
              {section.choices.map((choice, offset) => {
                const i = starts[n] + offset;
                return (
                  <button
                    key={`${choice.name}-${choice.url ?? ""}`}
                    id={optionId(i)}
                    type="button"
                    tabIndex={-1}
                    role="option"
                    aria-selected={i === current}
                    aria-label={choice.name}
                    title={`:${choice.label}:`}
                    className="cn-emoji-cell"
                    data-active={i === current ? "" : undefined}
                    onMouseMove={() => i !== current && setActive(i)}
                    onClick={() => onPick(choice.name)}
                  >
                    {choice.url ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a Slack CDN image
                      <img className="cn-emoji-img" src={choice.url} alt="" loading="lazy" />
                    ) : (
                      (choice.glyph ?? `:${choice.name}:`)
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The button that opens the panel. */
export function EmojiPickerButton({ label, open, onClick }: { label: string; open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="rs-button rs-button--ghost cn-emoji-open"
      aria-label={`Choose emoji for ${label}`}
      aria-expanded={open}
      onClick={onClick}
    >
      <Smile size={14} aria-hidden />
    </button>
  );
}

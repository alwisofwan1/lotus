"use client";

import { Minimize2, RotateCcw, Zap, type LucideIcon } from "lucide-react";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { filterSlashItems, rememberRecent, slashMessage, withRecent, type SlashItem, type SlashMatch } from "../domain/slash";
import { activeTrigger } from "../domain/trigger";
import { listSlashItems, type Runner } from "../runtime/chat-runtime-client";
import { Dither } from "./Dither";

// Mockup v4: https://claude.ai/artifact/Avcj6snNjLYCodpX5qf6xK. Plan: plans/chat-skills/PLAN.md.

// Every open re-reads (~1 s, in the background), so a skill added mid-thread shows up while the
// picker is open. The floor only stops a quick close-and-reopen from asking twice.
const STALE_MS = 5_000;

interface CacheEntry {
  items: SlashItem[] | null;
  error: string | null;
  at: number;
  loading: Promise<void> | null;
}

/** One list per (runner, folder) for the app's life; shown at once, refreshed when stale. */
const cache = new Map<string, CacheEntry>();
const listeners = new Set<() => void>();

const keyOf = (runner: Runner, cwd: string) => `${runner}\n${cwd}`;

/** `whenStale` false: only a list never read. */
function refresh(runner: Runner, cwd: string, whenStale: boolean): void {
  const known = cache.get(keyOf(runner, cwd));
  if (known && (known.loading || !whenStale || Date.now() - known.at < STALE_MS)) return;
  const entry = known ?? { items: null, error: null, at: 0, loading: null };
  cache.set(keyOf(runner, cwd), entry);
  entry.loading = listSlashItems(runner, cwd)
    .then((items) => Object.assign(entry, { items, error: null }))
    .catch((reason: unknown) => Object.assign(entry, { error: reason instanceof Error ? reason.message : String(reason) }))
    .then(() => {
      Object.assign(entry, { at: Date.now(), loading: null });
      listeners.forEach((l) => l());
    });
  listeners.forEach((l) => l());
}

/** Test seam: forget every list. */
export function resetSlashCache(): void {
  cache.clear();
}

const EMPTY: CacheEntry = { items: null, error: null, at: 0, loading: null };

function useSlashList(runner: Runner, cwd: string | null, enabled: boolean, open: boolean) {
  const [, rerender] = useState(0);
  useEffect(() => {
    const l = () => rerender((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  const on = enabled && !!cwd && runner !== "api";
  // Read once when the composer first shows, so the first `/` is instant; again on every open.
  useEffect(() => {
    if (on && cwd) refresh(runner, cwd, open);
  }, [on, runner, cwd, open]);
  return on && cwd ? (cache.get(keyOf(runner, cwd)) ?? EMPTY) : null;
}

const RECENT_KEY = "lotus.chat.slash.recent";

/** Skills picked lately, per runner. Browser storage: a convenience, so a failed read is just empty. */
function loadRecent(runner: Runner): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "{}") as Record<string, unknown>;
    const list = all[runner];
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

function saveRecent(runner: Runner, names: string[]): void {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "{}") as Record<string, unknown>;
    localStorage.setItem(RECENT_KEY, JSON.stringify({ ...all, [runner]: names }));
  } catch {
    // Remembering is a convenience only.
  }
}

export interface SlashOptions {
  runner: Runner;
  cwd: string | null;
  /** False while the composer cannot send (a request waits): `/` is plain text then. */
  enabled: boolean;
  /** The home has no context to clear, so it offers skills only. */
  commands: boolean;
  /** A command was picked: run it now. */
  onCommand: (name: string) => void;
  /** A skill was picked: remove the typed `/query` from the editor. */
  onSkill: () => void;
  /** A skill was picked mid-sentence: replace the `typed` chars before the caret with `text`. */
  onInsert: (text: string, typed: number) => void;
  /** A saved draft's chip, read once on mount. */
  initialSkill?: SlashItem | null;
}

export type SlashPicker = ReturnType<typeof useSlashPicker>;

/**
 * The `/` picker's state. The editor reports the text before the caret with `track()` and forwards
 * keys to `keyDown()` first; a pick becomes a chip before the editor, or runs a command.
 */
export function useSlashPicker({ runner, cwd, enabled, commands, onCommand, onSkill, onInsert, initialSkill = null }: SlashOptions) {
  const id = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [skill, setSkill] = useState<SlashItem | null>(initialSkill);
  const [armed, setArmed] = useState(false);
  // Mid-sentence: skills only, inserted where typed. At the start: commands too, and a chip.
  const [inline, setInline] = useState(false);
  const wantsOpen = enabled && query !== null && !dismissed && (inline || !skill);
  const list = useSlashList(runner, cwd, enabled, wantsOpen);
  const listed = wantsOpen && list !== null;
  const items = (list?.items ?? []).filter((item) => (commands && !inline) || item.kind === "skill");
  const all = listed ? filterSlashItems(items, query ?? "") : [];
  // Mid-sentence the name must contain the query: a loose subsequence would open on `/usr` too.
  const ranked = inline ? all.filter((m) => m.item.name.toLowerCase().includes((query ?? "").toLowerCase())) : all;
  // Mid-sentence, `/usr/bin` and the like are just text: no popover unless a skill matches.
  const open = listed && !(inline && ranked.length === 0 && (list.items !== null || list.error !== null));
  // Recent picks lead only before anything is typed; typing ranks by the name. Read only while open,
  // which never happens in the server pass.
  const matches = open && query === "" ? withRecent(ranked, loadRecent(runner)) : ranked;
  // Selection follows the name, so a refreshed list keeps it; a gone name falls back to the first.
  const activeIndex = Math.max(0, matches.findIndex((m) => m.item.name === activeName));
  const active: SlashMatch | null = matches[activeIndex] ?? null;

  const pick = (item: SlashItem) => {
    setQuery(null);
    setActiveName(null);
    if (inline) {
      saveRecent(runner, rememberRecent(loadRecent(runner), item.name));
      return onInsert(`/${item.name} `, (query?.length ?? 0) + 1);
    }
    if (item.kind === "command") return onCommand(item.name);
    setSkill(item);
    saveRecent(runner, rememberRecent(loadRecent(runner), item.name));
    onSkill();
  };

  return {
    id,
    open,
    query: query ?? "",
    loading: open && !list?.items && !list?.error,
    error: open ? (list?.error ?? null) : null,
    matches,
    active,
    activeIndex,
    skill,
    armed,
    optionId: (index: number) => `${id}-o${index}`,
    /** Props for the text box: a textbox that owns the listbox (ARIA 1.2), focus stays in it. */
    inputAria: {
      "aria-autocomplete": "list" as const,
      "aria-controls": open ? `${id}-list` : undefined,
      "aria-activedescendant": open && active ? `${id}-o${activeIndex}` : undefined,
    },
    track(beforeCaret: string) {
      const trigger = activeTrigger(beforeCaret);
      const next = trigger?.char === "/" ? trigger.query : null;
      setInline((trigger?.from ?? 0) > 0);
      if (next === null) setDismissed(false);
      if (next !== query) setActiveName(null);
      setQuery(next);
    },
    setActive: (name: string) => setActiveName(name),
    pick,
    /** True when the key was the picker's; the editor then does nothing with it. */
    keyDown(key: string, shift = false): boolean {
      if (armed && key !== "Backspace") setArmed(false);
      if (!open) return false;
      if (key === "Escape") {
        setDismissed(true);
        return true;
      }
      if (matches.length === 0) return false;
      if (key === "ArrowDown" || key === "ArrowUp") {
        const step = key === "ArrowDown" ? 1 : -1;
        setActiveName(matches[(activeIndex + step + matches.length) % matches.length].item.name);
        return true;
      }
      if ((key === "Enter" && !shift) || (key === "Tab" && !shift)) {
        pick(matches[activeIndex].item);
        return true;
      }
      return false;
    },
    /** Backspace at the start: the first press marks the chip, the second removes it. */
    backspaceAtStart(): boolean {
      if (!skill) return false;
      if (armed) {
        setSkill(null);
        setArmed(false);
      } else setArmed(true);
      return true;
    },
    removeSkill() {
      setSkill(null);
      setArmed(false);
    },
    /** The text to send for what is typed. */
    message: (text: string) => (skill ? slashMessage(skill.name, text) : text),
    clear() {
      setSkill(null);
      setArmed(false);
      setQuery(null);
    },
  };
}

const GROUP_LABELS = { recent: "Recent", command: "Commands", skill: "Skills" } as const;

const COMMAND_ICONS: Record<string, LucideIcon> = { clear: RotateCcw, compact: Minimize2 };

/** Gold ink in the head's empty right corner, away from the query text. */
const corner = (u: number, v: number) => Math.max(0, u - 0.3) * (1 - v) * 1.1;
const glow = (u: number, v: number) => Math.max(0, 1 - Math.hypot((u - 0.5) * 1.6, v * 2.2)) ** 1.4;

function Name({ match }: { match: SlashMatch }) {
  const { name } = match.item;
  const hits = new Set(match.hits);
  const ns = name.lastIndexOf(":") + 1;
  const parts: ReactNode[] = [];
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    parts.push(hits.has(i) ? <mark key={i}>{ch}</mark> : i < ns ? <span key={i} className="chat-slash-ns">{ch}</span> : ch);
  }
  return <span className="chat-slash-name">/{parts}</span>;
}

/** The popover. `place`: above the thread composer, below the home's box. */
export function SlashPopover({ slash, place }: { slash: SlashPicker; place: "above" | "below" }) {
  const listRef = useRef<HTMLDivElement>(null);
  const { open, matches, active, activeIndex } = slash;

  useLayoutEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[id="${slash.optionId(activeIndex)}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex, slash]);

  if (!open) return null;
  // Same order as `matches`, so the arrows walk the rows top to bottom.
  const groupOf = (m: SlashMatch) => (m.recent ? "recent" : m.item.kind);
  const groups = (["recent", "command", "skill"] as const)
    .map((kind) => ({ kind, rows: matches.map((m, index) => ({ m, index })).filter(({ m }) => groupOf(m) === kind) }))
    .filter((g) => g.rows.length > 0);
  const count = `${matches.length} ${matches.length === 1 ? "result" : "results"}`;

  return (
    <div className="chat-slash" data-place={place} onMouseDown={(event) => event.preventDefault()}>
      <Dither className="chat-slash-corner" field={corner} />
      <div className="chat-slash-head">
        <span className="chat-slash-query">/{slash.query}</span>
        {!slash.loading && !slash.error && <span className="chat-slash-count">{count}</span>}
      </div>
      {/* Read once per change; the list itself is not live. */}
      <span className="sr-only" role="status" aria-live="polite">
        {slash.loading ? "Loading skills" : slash.error ? "" : count}
      </span>
      {slash.loading ? (
        <div className="chat-slash-loading">
          <span className="chat-working" aria-hidden />
          Loading skills…
        </div>
      ) : slash.error && matches.length === 0 ? (
        <div className="chat-slash-empty" role="alert">
          <b>Could not load skills</b>
          <p>{slash.error}</p>
        </div>
      ) : matches.length === 0 ? (
        <div className="chat-slash-empty">
          <Dither className="chat-slash-glow" field={glow} />
          <b>/{slash.query}</b>
          <p>No command or skill matches.</p>
          <p className="chat-slash-quiet">Keep typing to send it as plain text.</p>
        </div>
      ) : (
        <>
          <div ref={listRef} id={`${slash.id}-list`} className="chat-slash-list" role="listbox" aria-label="Commands and skills">
            {groups.map((g) => (
              <Fragment key={g.kind}>
                <div className="chat-slash-group" role="presentation">
                  {GROUP_LABELS[g.kind]} <span>{g.rows.length}</span>
                </div>
                {g.rows.map(({ m, index }) => {
                  const Icon = m.item.kind === "skill" ? Zap : (COMMAND_ICONS[m.item.name] ?? RotateCcw);
                  return (
                    <div
                      key={`${m.item.kind}:${m.item.name}`}
                      id={slash.optionId(index)}
                      className="chat-slash-row"
                      role="option"
                      aria-selected={index === activeIndex}
                      data-kind={m.item.kind}
                      onMouseMove={() => index !== activeIndex && slash.setActive(m.item.name)}
                      onClick={() => slash.pick(m.item)}
                    >
                      <Icon className="chat-slash-icon" size={14} aria-hidden />
                      <Name match={m} />
                      <span className="chat-slash-desc">{m.item.description}</span>
                      <span className="chat-slash-act" aria-hidden>
                        {m.item.kind === "skill" ? "add" : "run"} ⏎
                      </span>
                    </div>
                  );
                })}
              </Fragment>
            ))}
          </div>
          {active && (
            <div className="chat-slash-detail">
              <span className="chat-slash-detail-text">{active.item.description || "No description."}</span>
              <span className="chat-slash-detail-meta">
                {[active.item.argumentHint && <code key="h">{active.item.argumentHint}</code>, active.item.source, active.item.path && <code key="p">{active.item.path}</code>]
                  .filter(Boolean)
                  .map((part, i) => (
                    <Fragment key={i}>
                      {i > 0 && <span aria-hidden>·</span>}
                      {part}
                    </Fragment>
                  ))}
              </span>
            </div>
          )}
        </>
      )}
      <div className="chat-slash-keys" aria-hidden>
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> move
        </span>
        <span>
          <kbd>⏎</kbd> pick
        </span>
        <span>
          <kbd>esc</kbd> close
        </span>
      </div>
    </div>
  );
}

/** The picked skill, before the text. Backspace at the start marks it, then removes it. */
export function SkillChip({ slash }: { slash: SlashPicker }) {
  if (!slash.skill) return null;
  return (
    <span className="chat-skill-chip" data-armed={slash.armed || undefined} title={slash.skill.description}>
      <Zap size={11} aria-hidden />
      {slash.skill.name}
      <button type="button" className="sr-only" onClick={slash.removeSkill}>
        Remove skill {slash.skill.name}
      </button>
    </span>
  );
}

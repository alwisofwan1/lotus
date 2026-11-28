"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pencil, Pin, Search, SlidersHorizontal, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { LAYOUT_TEMPLATES } from "./constants";
import type { LayoutTemplate, Preset } from "./types";
import { useFormatShortcut } from "@/lib/hooks/useShortcutLabel";

const DAY = 86_400_000;
const lastUsed = (p: Preset) => p.lastOpenedAt ?? p.updatedAt;
const byRecent = (a: Preset, b: Preset) => lastUsed(b) - lastUsed(a);
export const templateOf = (p: Preset) => LAYOUT_TEMPLATES.find(t => t.id === p.templateId) ?? LAYOUT_TEMPLATES[0];
export const leafName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
/** Where a preset opens: its folder, prefixed with the machine when that is not this Mac. */
export const placeOf = (p: Preset) => (p.location ? `${p.location.host}:${p.cwd}` : p.cwd);

/** Pinned first, then most recently opened — the order of "Jump back in". */
export function presetOrder(presets: Preset[]): Preset[] {
  return [...presets].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || byRecent(a, b));
}

export function MiniGrid({ tpl, filled = 0 }: { tpl: LayoutTemplate; filled?: number }) {
  return (
    <div className="cl-mini" style={{ gridTemplateColumns: `repeat(${tpl.cols},1fr)`, gridTemplateRows: `repeat(${tpl.rows},1fr)` }}>
      {Array.from({ length: tpl.sessions }, (_, i) => <i key={i} className={i < filled ? "is-on" : undefined} />)}
    </div>
  );
}

export function ago(ms: number, now = Date.now()): string {
  const days = Math.floor((now - ms) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.round(days / 7)} wk ago`;
  return `${Math.round(days / 30)} mo ago`;
}

function Hit({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark className="cl-hit">{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

interface Props {
  presets: Preset[];
  agentNames: (p: Preset) => string[];
  onOpen: (p: Preset) => void;
  onEdit: (p: Preset) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string) => void;
  onClose: () => void;
  /** The preset just deleted, with a way back. */
  undo: { name: string; restore: () => void } | null;
}

/** Every saved preset, one search away (`mockups/workspace-create-revamp.html`, screen 1b). */
export function PresetPalette({ presets, agentNames, onOpen, onEdit, onRename, onDelete, onTogglePin, onClose, undo }: Props) {
  const [query, setQuery] = useState("");
  const [hl, setHl] = useState(0);
  const shortcut = useFormatShortcut();
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();

  const groups = useMemo(() => {
    const match = (p: Preset) => !q || p.name.toLowerCase().includes(q) || placeOf(p).toLowerCase().includes(q)
      || agentNames(p).some(n => n.toLowerCase().includes(q));
    const found = presets.filter(match).sort(byRecent);
    if (q) return [{ label: "Results", items: found }];
    const now = Date.now();
    return [
      { label: "Pinned", items: found.filter(p => p.pinned) },
      { label: "Recent", items: found.filter(p => !p.pinned && now - lastUsed(p) < 7 * DAY) },
      { label: "Older · A–Z", items: found.filter(p => !p.pinned && now - lastUsed(p) >= 7 * DAY).sort((a, b) => a.name.localeCompare(b.name)) },
    ].filter(g => g.items.length > 0);
  }, [presets, q, agentNames]);
  const flat = groups.flatMap(g => g.items);
  const current = flat[Math.min(hl, flat.length - 1)];

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".cl-prow.is-hl")?.scrollIntoView?.({ block: "nearest" });
  }, [hl]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setHl(h => Math.min(h + 1, flat.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHl(h => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && current) { e.preventDefault(); if (e.metaKey || e.ctrlKey) return; onOpen(current); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e" && current) { e.preventDefault(); onEdit(current); }
    else if ((e.metaKey || e.ctrlKey) && e.key === "." && current) { e.preventDefault(); onTogglePin(current.id); }
  };

  const commitRename = () => {
    if (renaming) onRename(renaming.id, renaming.name);
    setRenaming(null);
  };

  let index = -1;
  return (
    <div className="cl-overlay" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="cl-palette" role="dialog" aria-label="All presets">
        <label className="cl-palette-search">
          <Search size={17} />
          <input autoFocus value={query} onKeyDown={onKeyDown} aria-label="Search presets"
            placeholder={`Search ${presets.length} presets by name, folder or agent`}
            onChange={e => { setQuery(e.target.value); setHl(0); }} />
          <span className="cl-kbd">Esc</span>
        </label>
        <div className="cl-palette-body" role="listbox" aria-label="Presets" ref={listRef}>
          {flat.length === 0 && (
            <div className="cl-palette-empty">No preset matches “{query.trim()}”.</div>
          )}
          {groups.map(g => (
            <div key={g.label}>
              <div className="cl-grp">{g.label}<span>{g.items.length}</span></div>
              {g.items.map(p => {
                index += 1;
                const i = index;
                const tpl = templateOf(p);
                const names = agentNames(p);
                const agents = Object.values(p.agentSlots).reduce((s, n) => s + Math.max(0, n), 0);
                const on = current?.id === p.id;
                return (
                  <div key={p.id} role="option" aria-selected={on} className={cn("cl-prow", on && "is-hl")}
                    onMouseEnter={() => setHl(i)} onClick={() => renaming?.id !== p.id && onOpen(p)}>
                    <span className="cl-prow-grid"><MiniGrid tpl={tpl} filled={agents} /></span>
                    <span className="cl-prow-main">
                      <span className="cl-prow-name">
                        {renaming?.id === p.id ? (
                          <input autoFocus value={renaming.name} aria-label="Preset name"
                            onClick={e => e.stopPropagation()}
                            onChange={e => setRenaming({ id: p.id, name: e.target.value })}
                            onKeyDown={e => {
                              e.stopPropagation();
                              if (e.key === "Enter") commitRename();
                              if (e.key === "Escape") setRenaming(null);
                            }}
                            onBlur={commitRename} />
                        ) : <Hit text={p.name} q={q} />}
                        {p.pinned && <Pin size={11} aria-label="Pinned" />}
                      </span>
                      <span className="cl-prow-sub cl-mono"><Hit text={placeOf(p)} q={q} /></span>
                    </span>
                    <span className="cl-prow-meta">
                      {names.length > 0 && <span className="cl-prow-agents"><Hit text={names.join(", ")} q={q} /></span>}
                      <span className="cl-prow-when">{tpl.sessions} pane{tpl.sessions === 1 ? "" : "s"} · {ago(lastUsed(p))}</span>
                      <span className="cl-prow-act" onClick={e => e.stopPropagation()}>
                        <button type="button" className={cn("cl-icon-btn", p.pinned && "is-on")} onClick={() => onTogglePin(p.id)}
                          title={p.pinned ? "Unpin" : "Pin to Jump back in"} aria-label={`${p.pinned ? "Unpin" : "Pin"} ${p.name}`}><Pin size={14} /></button>
                        <button type="button" className="cl-icon-btn" onClick={() => onEdit(p)}
                          title={`Edit in form (${shortcut("⌘E")})`} aria-label={`Edit ${p.name}`}><SlidersHorizontal size={14} /></button>
                        <button type="button" className="cl-icon-btn" onClick={() => setRenaming({ id: p.id, name: p.name })}
                          title="Rename" aria-label={`Rename ${p.name}`}><Pencil size={14} /></button>
                        <button type="button" className="cl-icon-btn is-danger" onClick={() => onDelete(p.id)}
                          title="Delete" aria-label={`Delete ${p.name}`}><Trash2 size={14} /></button>
                        <button type="button" className="cl-open-btn" onClick={() => onOpen(p)}>Open ↵</button>
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="cl-palette-foot">
          {undo ? (
            <span className="cl-undo" role="status">Deleted “{undo.name}”<button type="button" onClick={undo.restore}>Undo</button></span>
          ) : (
            <>
              <span><span className="cl-kbd">↑↓</span> move</span>
              <span><span className="cl-kbd">↵</span> open</span>
              <span><span className="cl-kbd">{shortcut("⌘E")}</span> edit in form</span>
              <span><span className="cl-kbd">{shortcut("⌘.")}</span> pin</span>
            </>
          )}
          <span className="cl-pfoot-grow" />
          <span>Sorted by last opened</span>
        </div>
      </div>
    </div>
  );
}

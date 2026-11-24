"use client";

import { Check, Info, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FactoryCatalog } from "@/lib/tauri/graph-run";
import { filterServers, filterSkills, type SkillFilter } from "../services/factory-agents";

const SKILL_FILTERS: { id: SkillFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "factory", label: "Factory" },
  { id: "repo", label: "Repo" },
  { id: "meta", label: "Meta-repo" },
  { id: "user", label: "User" },
  { id: "plugin", label: "Plugin" },
];

/** This Mac's skills or MCP servers to tick; Esc or a click outside closes it. */
export function CatalogPicker({
  kind,
  catalog,
  chosen,
  onToggle,
  onClose,
}: {
  kind: "skills" | "mcp";
  catalog: FactoryCatalog;
  chosen: string[];
  onToggle: (name: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SkillFilter>("all");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);
  const items =
    kind === "skills"
      ? filterSkills(catalog, query, filter).map((s) => ({ name: s.id, line: s.description ?? "", tag: s.source, plugin: s.plugin }))
      : filterServers(catalog, query).map((m) => ({ name: m.name, line: `${m.transport} · ${m.target}`, tag: m.scope, plugin: m.plugin }));
  const total = kind === "skills" ? catalog.skills.length : catalog.mcp.length;
  const noun = kind === "skills" ? "skills" : "servers";
  return (
    <div
      ref={box}
      className="fa-picker"
      role="dialog"
      aria-label={kind === "skills" ? "Add skill" : "Add server"}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <label className="fa-picker-search">
        <Search size={13} aria-hidden />
        <input autoFocus aria-label={`Search ${noun}`} placeholder={`Search ${total} ${noun}`} value={query} onChange={(e) => setQuery(e.target.value)} />
        <span className="fa-pane-hint">
          {items.length === total ? total : `${items.length} of ${total}`}
        </span>
      </label>
      {kind === "skills" ? (
        <div className="fa-picker-filters" role="group" aria-label="Where the skill comes from">
          {SKILL_FILTERS.map((f) => (
            <button key={f.id} type="button" className="fa-filter" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      ) : null}
      <ul className="fa-picker-list">
        {items.length === 0 ? <li className="fa-pane-hint fa-picker-empty">Nothing matches.</li> : null}
        {items.map((item) => {
          const on = chosen.includes(item.name);
          return (
            <li key={item.name}>
              <button type="button" className="fa-picker-item" role="menuitemcheckbox" aria-checked={on} onClick={() => onToggle(item.name)}>
                <span className="fa-check" data-on={on ? "true" : undefined} aria-hidden>
                  {on ? <Check size={10} /> : null}
                </span>
                <span className="fa-picker-text">
                  <span className="fa-tag-name">{item.name}</span>
                  {item.plugin ? <span className="fa-picker-line" title={`Plugin: ${item.plugin}`}>Plugin: {item.plugin}</span> : null}
                  {item.line ? <span className="fa-picker-line">{item.line}</span> : null}
                </span>
                <span className="fa-tag-src">{item.tag}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="fa-picker-foot">
        <Info size={12} aria-hidden />
        {kind === "skills"
          ? "A factory or repo skill wins over a user skill with the same name."
          : "Keys and args stay in your config; Lotus shows only the name and host."}
      </p>
    </div>
  );
}

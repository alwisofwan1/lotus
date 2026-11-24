"use client";

import { Inbox, LayoutList, Loader, Plug, Send, Sparkles, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { Automation } from "../services/automation-api";
import { triggerOf } from "../services/automation-list";
import { TriggerIcon } from "./InstalledTab";

/**
 * Automation's own sidebar, Slack's channel list: the shared views first (Inbox, All, Examples),
 * then one row per automation — on ones first, off ones dimmed — each with what waits for you.
 *
 * `variant="rail"` is the same list drawn inside the host's own sidebar (the shell's rail), under
 * the host's back row, which is its way out, so this variant leaves out its title and close button.
 */

export type SidebarView =
  | { kind: "inbox" }
  | { kind: "running" }
  | { kind: "sent" }
  | { kind: "all" }
  | { kind: "browse" }
  | { kind: "channel"; id: string };

/** From this many automations on, the sidebar offers a filter: a long list is found, not scrolled. */
export const SIDEBAR_FILTER_FROM = 8;

export function AutomationSidebar({
  automations,
  pending,
  inboxCount,
  failing,
  runningCount = 0,
  view,
  onSelect,
  newButton,
  onClose,
  onOpenConnectors,
  variant = "own",
}: {
  automations: Automation[];
  /** What waits for you, by automation id. */
  pending: Map<string, number>;
  inboxCount: number;
  /** Automations whose last run failed: a red dot on their row. */
  failing?: Set<string>;
  /** Runs working right now, across every automation. */
  runningCount?: number;
  view: SidebarView | null;
  onSelect: (view: SidebarView) => void;
  /** The "New automation" control: its menu lives with the surface. */
  newButton: ReactNode;
  onClose: () => void;
  onOpenConnectors?: () => void;
  variant?: "own" | "rail";
}) {
  const own = variant === "own";
  const [query, setQuery] = useState("");
  const filtering = automations.length >= SIDEBAR_FILTER_FROM;
  const needle = filtering ? query.trim().toLowerCase() : "";
  const shown = needle ? automations.filter((a) => a.name.toLowerCase().includes(needle)) : automations;
  const ordered = [...shown.filter((a) => a.enabled), ...shown.filter((a) => !a.enabled)];
  const is = (kind: SidebarView["kind"], id?: string) =>
    view?.kind === kind && (kind !== "channel" || (view.kind === "channel" && view.id === id));

  return (
    <aside className="au-side" data-variant={variant} aria-label="Automations sidebar">
      {own ? (
        <div className="au-side-head">
          <span className="au-side-title">Automations</span>
          <button type="button" className="rs-icon-button" onClick={onClose} aria-label="Close automations" title="Close">
            <X size={15} strokeWidth={1.75} aria-hidden />
          </button>
        </div>
      ) : null}
      <div className="au-side-new">{newButton}</div>

      <nav className="au-side-group" aria-label="Automation views">
        <SideItem icon={<Inbox size={14} aria-hidden />} label="Inbox" count={inboxCount} active={is("inbox")} onClick={() => onSelect({ kind: "inbox" })} />
        <SideItem
          icon={<Loader size={14} aria-hidden />}
          label="Running now"
          count={runningCount}
          quiet
          active={is("running")}
          onClick={() => onSelect({ kind: "running" })}
        />
        <SideItem icon={<Send size={14} aria-hidden />} label="Sent" active={is("sent")} onClick={() => onSelect({ kind: "sent" })} />
        <SideItem
          icon={<LayoutList size={14} aria-hidden />}
          label="All automations"
          count={automations.length}
          quiet
          active={is("all")}
          onClick={() => onSelect({ kind: "all" })}
        />
      </nav>

      <div className="au-side-label" aria-hidden>
        Automations
      </div>
      {filtering ? (
        <input
          type="search"
          className="au-input au-side-filter"
          aria-label="Find an automation"
          placeholder="Find an automation"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      ) : null}
      {ordered.length === 0 ? (
        <p className="au-side-none">{needle ? `No automation matches “${query.trim()}”.` : "None yet. Start from an example below."}</p>
      ) : (
        <ul className="au-side-group au-side-channels" aria-label="Automation channels">
          {ordered.map((a) => (
            <li key={a.id}>
              <SideItem
                icon={<TriggerIcon kind={triggerOf(a).kind} size={14} />}
                label={a.name}
                count={pending.get(a.id) ?? 0}
                off={!a.enabled}
                failed={failing?.has(a.id)}
                active={is("channel", a.id)}
                onClick={() => onSelect({ kind: "channel", id: a.id })}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="au-side-foot">
        <SideItem icon={<Sparkles size={14} aria-hidden />} label="Browse examples" active={is("browse")} onClick={() => onSelect({ kind: "browse" })} />
        {onOpenConnectors ? <SideItem icon={<Plug size={14} aria-hidden />} label="Connectors" onClick={onOpenConnectors} /> : null}
      </div>
    </aside>
  );
}

function SideItem({
  icon,
  label,
  count = 0,
  active = false,
  off = false,
  failed = false,
  quiet = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  count?: number;
  active?: boolean;
  /** An automation that is turned off: still there, but quiet. */
  off?: boolean;
  /** Its last run failed: a red dot, so it is seen before the 3-strike pause. */
  failed?: boolean;
  /** A count that is a total, not something waiting: no badge. */
  quiet?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="au-side-item"
      data-active={active || undefined}
      data-off={off || undefined}
      aria-current={active ? "page" : undefined}
      aria-label={label}
      title={failed ? `${label}: last run failed` : off ? `${label} (off)` : label}
      onClick={onClick}
    >
      <span className="au-side-icon" aria-hidden>
        {icon}
      </span>
      <span className="au-side-name">{label}</span>
      {failed ? <span className="au-side-fail" aria-label="last run failed" /> : null}
      {count > 0 ? (
        <span className={quiet ? "au-side-total" : "au-side-badge"} aria-hidden>
          {count}
        </span>
      ) : null}
    </button>
  );
}

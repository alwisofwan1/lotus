"use client";

import { ChevronDown, ChevronRight, CircleCheck, CircleX, CornerDownRight, Loader2, MessageCircleQuestion, MoreHorizontal, Search } from "lucide-react";
import {
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";

import "@/styles/resource-kit.css";

/**
 * The resource kit: the one vocabulary list-and-detail surfaces are built from (Automations,
 * Connectors, and whatever comes next). Modelled on bb's `packages/shared-ui/…/resource/` —
 * page band, tabs, toolbar, one bordered list with hairline rows, detail header and sections —
 * and drawn with Lotus's own tokens (`--ws-*`, `--ds-t-*`), so a resource page reads as part of
 * the same window as Tasks and the panes.
 *
 * Menus are `<details>`, as in Tasks: the browser gives open/close and outside-click for free.
 * Escape it does not, which `closeOnEscape` adds.
 */

// ── Frame ─────────────────────────────────────────────────────────────────────

export type Crumb = { label: string; onClick?: () => void };

/** The bar at the top of the surface: where you are, and the surface's own controls. */
export function ResourceBar({ crumbs, actions }: { crumbs: Crumb[]; actions?: ReactNode }) {
  return (
    <header className="rs-bar">
      <nav aria-label="Breadcrumb" className="rs-crumbs">
        <ol>
          {crumbs.map((crumb, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li key={`${crumb.label}-${i}`}>
                {i > 0 ? <ChevronRight size={14} className="rs-crumb-sep" aria-hidden /> : null}
                {last || !crumb.onClick ? (
                  <span className="rs-crumb" aria-current={last ? "page" : undefined}>
                    {crumb.label}
                  </span>
                ) : (
                  <button type="button" className="rs-crumb rs-crumb--link" onClick={crumb.onClick}>
                    {crumb.label}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      {actions ? <div className="rs-bar-actions">{actions}</div> : null}
    </header>
  );
}

/** The scrolling page and its centred band. `detail` is the narrower reading width. */
export function ResourcePage({ width = "list", children }: { width?: "list" | "detail"; children: ReactNode }) {
  return (
    <div className="rs-scroll">
      <div className="rs-band" data-width={width}>
        {children}
      </div>
    </div>
  );
}

export function ResourceDescription({ children }: { children: ReactNode }) {
  return <p className="rs-description">{children}</p>;
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

/** `hint` is read after the label and shown as the tooltip; `tone` colours the count. */
export type Tab<T extends string> = { id: T; label: string; count?: number; hint?: string; tone?: "attention" };

export function ResourceTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: Tab<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (event: KeyboardEvent, index: number) => {
    const last = tabs.length - 1;
    const to =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (to === null) return;
    event.preventDefault();
    onChange(tabs[to].id);
    refs.current[to]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="rs-tabs">
      {tabs.map((tab, i) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className="rs-tab"
            title={tab.hint}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => move(e, i)}
          >
            {tab.label}
            {tab.count ? (
              <span className="rs-tab-count" data-tone={tab.tone}>
                {tab.count}
              </span>
            ) : null}
            {tab.hint ? <span className="rs-tab-hint">, {tab.hint}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

// ── Menus ─────────────────────────────────────────────────────────────────────

function closeOnEscape(event: KeyboardEvent<HTMLDetailsElement>) {
  if (event.key !== "Escape" || !event.currentTarget.open) return;
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.open = false;
  event.currentTarget.querySelector("summary")?.focus();
}

/** Closes the `<details>` a menu item sits in, so a pick never leaves its menu hanging open. */
export function closeMenuOf(event: MouseEvent<HTMLElement>) {
  event.currentTarget.closest("details")?.removeAttribute("open");
}

export function ResourceMenu({
  trigger,
  label,
  active,
  align = "end",
  className,
  children,
}: {
  trigger: ReactNode;
  label: string;
  /** Lit while a filter chosen in it is in effect. */
  active?: boolean;
  align?: "start" | "end";
  className?: string;
  children: ReactNode;
}) {
  return (
    <details className={`rs-menu ${className ?? ""}`} onKeyDown={closeOnEscape}>
      <summary className="rs-menu-trigger" aria-label={label} title={label} data-active={active ? "true" : undefined}>
        {trigger}
      </summary>
      <div className="rs-menu-content" role="menu" data-align={align}>
        {children}
      </div>
    </details>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="rs-menu-label">{children}</div>;
}

export function MenuSeparator() {
  return <div className="rs-menu-sep" role="separator" />;
}

export function MenuItem({
  icon,
  children,
  onSelect,
  checked,
  tone,
  disabled,
  keepOpen,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  /** Present for checkbox items. */
  checked?: boolean;
  tone?: "danger";
  disabled?: boolean;
  keepOpen?: boolean;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      className="rs-menu-item"
      data-tone={tone}
      disabled={disabled}
      onClick={(event) => {
        if (!keepOpen) closeMenuOf(event);
        onSelect();
      }}
    >
      {checked !== undefined ? (
        <span className="rs-menu-check" aria-hidden>
          {checked ? <CircleCheck size={14} /> : null}
        </span>
      ) : icon ? (
        <span className="rs-menu-icon" aria-hidden>
          {icon}
        </span>
      ) : null}
      <span className="rs-menu-text">{children}</span>
    </button>
  );
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

export function ResourceToolbar({ children }: { children: ReactNode }) {
  return <div className="rs-toolbar">{children}</div>;
}

export function ResourceSearch({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="rs-search">
      <Search size={14} aria-hidden />
      <input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange("");
          }
        }}
      />
    </label>
  );
}

/** The primary action with its variants beside it, as bb's "New automation". */
export function SplitButton({
  icon,
  label,
  onClick,
  menuLabel,
  children,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  menuLabel: string;
  children: ReactNode;
}) {
  return (
    <div className="rs-split">
      <button type="button" className="rs-button rs-button--primary rs-split-main" onClick={onClick}>
        {icon}
        {label}
      </button>
      <ResourceMenu
        className="rs-split-menu"
        label={menuLabel}
        trigger={<ChevronDown size={14} aria-hidden />}
      >
        {children}
      </ResourceMenu>
    </div>
  );
}

// ── List ──────────────────────────────────────────────────────────────────────

export function ResourceList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul className="rs-list" aria-label={label}>
      {children}
    </ul>
  );
}

/**
 * One row. The title is the button that opens it, stretched over the whole row, so the row is
 * one target for the pointer and one tab stop for the keyboard, while the switch and menus in
 * `trailing` stay their own controls on top.
 */
export function ResourceRow({
  label,
  leading,
  title,
  titleMeta,
  meta,
  trailing,
  onOpen,
  muted,
}: {
  label: string;
  leading?: ReactNode;
  title: ReactNode;
  titleMeta?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  onOpen?: () => void;
  muted?: boolean;
}) {
  return (
    <li className="rs-row" aria-label={label} data-muted={muted ? "true" : undefined} data-openable={onOpen ? "true" : undefined}>
      {leading ? <span className="rs-row-leading">{leading}</span> : null}
      <span className="rs-row-body">
        <span className="rs-row-titleline">
          {onOpen ? (
            <button type="button" className="rs-row-title rs-row-open" onClick={onOpen}>
              {title}
            </button>
          ) : (
            <span className="rs-row-title">{title}</span>
          )}
          {titleMeta}
        </span>
        {meta ? <span className="rs-row-meta">{meta}</span> : null}
      </span>
      <span className="rs-row-trailing">
        {trailing}
        {onOpen ? <ChevronRight size={14} className="rs-row-chevron" aria-hidden /> : null}
      </span>
    </li>
  );
}

export type MetaItem = { icon?: ReactNode; text: string; title?: string };

/** "acme-main · 5PM Mon-Fri · Next Sep 26, 9:00 AM" */
export function ResourceMeta({ items }: { items: MetaItem[] }) {
  return (
    <span className="rs-meta">
      {items.map((item, i) => (
        <span key={`${item.text}-${i}`} className="rs-meta-item" title={item.title}>
          {i > 0 ? <span className="rs-meta-sep" aria-hidden>·</span> : null}
          {item.icon ? <span className="rs-meta-icon" aria-hidden>{item.icon}</span> : null}
          {item.text}
        </span>
      ))}
    </span>
  );
}

export function Pill({ tone = "neutral", children, title }: { tone?: "neutral" | "warn" | "danger" | "ok" | "accent"; children: ReactNode; title?: string }) {
  return (
    <span className="rs-pill" data-tone={tone} title={title}>
      {children}
    </span>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      className="rs-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="rs-switch-thumb" />
    </button>
  );
}

export function OverflowMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ResourceMenu className="rs-overflow" label={label} trigger={<MoreHorizontal size={16} aria-hidden />}>
      {children}
    </ResourceMenu>
  );
}

// ── States ────────────────────────────────────────────────────────────────────

/** `art` is a quiet backdrop behind the message (a surface's own texture); it is never read out. */
export function EmptyState({ children, action, art }: { children: ReactNode; action?: ReactNode; art?: ReactNode }) {
  return (
    <div className="rs-empty" data-art={art ? "true" : undefined}>
      {art}
      <div>{children}</div>
      {action}
    </div>
  );
}

/** Skeleton rows in the list's own shape, so the page does not jump when it loads. */
export function SkeletonRows({ count = 4, label }: { count?: number; label: string }) {
  return (
    <ul className="rs-list" aria-label={label} aria-busy="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="rs-row rs-row--skeleton">
          <span className="rs-skel rs-skel--icon" />
          <span className="rs-row-body">
            <span className="rs-skel rs-skel--title" />
            <span className="rs-skel rs-skel--meta" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A detail page's skeleton: a title, a meta line and a short paragraph, in the page's own place. */
export function SkeletonDetail({ label }: { label: string }) {
  return (
    <div className="rs-skel-detail" role="status" aria-label={label} aria-busy="true">
      <span className="rs-skel rs-skel--heading" />
      <span className="rs-skel rs-skel--meta" />
      <span className="rs-skel rs-skel--line" />
      <span className="rs-skel rs-skel--line" />
      <span className="rs-skel rs-skel--line rs-skel--short" />
    </div>
  );
}

// ── Detail ────────────────────────────────────────────────────────────────────

export function DetailHeader({
  icon,
  title,
  meta,
  actions,
  level = 1,
}: {
  icon?: ReactNode;
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
  /** 2 when the header sits in a pane beside a page that already has its own h1; 3 under a pane's own h2. */
  level?: 1 | 2 | 3;
}) {
  const Heading = level === 1 ? "h1" : level === 2 ? "h2" : "h3";
  return (
    <div className="rs-dhead">
      <div className="rs-dhead-main">
        <div className="rs-dhead-titleline">
          {icon ? <span className="rs-dhead-icon" aria-hidden>{icon}</span> : null}
          <Heading className="rs-dhead-title">{title}</Heading>
        </div>
        {meta ? <div className="rs-dhead-meta">{meta}</div> : null}
      </div>
      {actions ? <div className="rs-dhead-actions">{actions}</div> : null}
    </div>
  );
}

export function DetailSection({
  title,
  actions,
  children,
  id,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className="rs-section" aria-labelledby={headingId} id={id}>
      <div className="rs-section-head">
        <h2 className="rs-section-title" id={headingId}>
          {title}
        </h2>
        {actions ? <div className="rs-section-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function IconButton({
  label,
  onClick,
  children,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button type="button" className="rs-icon-button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

/** A run's outcome as an icon: never colour alone — each state has its own shape. */
export function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "running":
    case "queued":
      return <Loader2 size={14} className="rs-status rs-status--busy" aria-label="Running" />;
    case "succeeded":
      return <CircleCheck size={14} className="rs-status rs-status--ok" aria-label="Succeeded" />;
    case "skipped":
      return <CornerDownRight size={14} className="rs-status rs-status--muted" aria-label="Skipped" />;
    case "asked":
      return <MessageCircleQuestion size={14} className="rs-status rs-status--warn" aria-label="Waiting for your answer" />;
    default:
      return <CircleX size={14} className="rs-status rs-status--fail" aria-label={status === "interrupted" ? "Interrupted" : "Failed"} />;
  }
}

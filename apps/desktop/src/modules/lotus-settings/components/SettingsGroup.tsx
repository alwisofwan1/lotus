"use client";
import type { ReactNode } from "react";
import { Collapse } from "@/components/ui/collapse";

/**
 * The two settings molecules (mockups/settings-redesign.html). Every section is a stack of
 * SettingsGroups; every line inside one is a SettingRow. Skin: `.ui-group*` / `.ui-row*` in
 * styles/ui-kit.css, app palette only.
 */

interface SettingsGroupProps {
  /** Small heading above the card. Omit for a heading-less card. */
  title?: string;
  /** One-line meta after the title ("All up to date · checked 1 min ago"). */
  meta?: ReactNode;
  /** Controls pinned right in the heading (a refresh icon button). */
  action?: ReactNode;
  /** Sentence under the heading, above the card. */
  description?: ReactNode;
  /** Quiet line under the card. */
  footer?: ReactNode;
  /** `ul` when the rows are a list of things (CLIs, accounts), else `div`. */
  as?: "div" | "ul";
  children: ReactNode;
}

export function SettingsGroup({ title, meta, action, description, footer, as: Card = "div", children }: SettingsGroupProps) {
  return (
    <section className="ui-group">
      {title || meta || action ? (
        <div className="ui-group-head">
          {title ? <h3 className="ui-group-title">{title}</h3> : null}
          <span className="ui-group-meta" aria-live="polite">{meta}</span>
          {action}
        </div>
      ) : null}
      {description ? <p className="ui-group-desc">{description}</p> : null}
      <Card className="ui-group-card">{children}</Card>
      {footer ? <div className="ui-group-foot">{footer}</div> : null}
    </section>
  );
}

interface SettingRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** Render the description in mono (versions, paths). */
  monoDescription?: boolean;
  /** Leading IconTile. */
  leading?: ReactNode;
  /** Controls pinned right. */
  children?: ReactNode;
  /** Dim the row (not installed, unavailable). */
  muted?: boolean;
  /** Extra content inside the row's card slot, under it (a preview, a fineprint, a drawer). */
  body?: ReactNode;
  /** Render as `li` inside a `ul` group. */
  as?: "div" | "li";
  /** The chosen row of a single-choice list: a soft tint, and its `.ui-row-reveal` controls stay visible. */
  selected?: boolean;
  /** Set to make `body` open and close with an animation (a list of expandable rows). */
  expanded?: boolean;
}

export function SettingRow({ label, description, monoDescription, leading, children, muted, body, as: Tag = "div", selected, expanded }: SettingRowProps) {
  const row = (
    <div className="ui-row" data-muted={muted ? "" : undefined}>
      {leading}
      <div className="ui-row-text">
        <span className="ui-row-label">{label}</span>
        {description ? (
          <span className="ui-row-desc" data-mono={monoDescription ? "" : undefined}>
            {description}
          </span>
        ) : null}
      </div>
      {children ? <div className="ui-row-ctl">{children}</div> : null}
    </div>
  );
  // Always the same wrapper: a body that appears later must not remount the controls above it.
  return (
    <Tag className="ui-row-item" data-selected={selected ? "" : undefined}>
      {row}
      {expanded === undefined ? (
        body ? <div className="ui-row-body" data-indent={leading ? "" : undefined}>{body}</div> : null
      ) : (
        <Collapse open={expanded}>
          <div className="ui-row-body" data-indent={leading ? "" : undefined}>{body}</div>
        </Collapse>
      )}
    </Tag>
  );
}

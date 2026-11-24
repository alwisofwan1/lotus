"use client";

import { openExternalLink } from "@/lib/tauri-api";
// The dot is drawn in Connectors too, which may open before Tasks ever has.
import "@/styles/tasks.css";
import { HEALTH_ACTION_LABELS, type HealthAction, type HealthView } from "@/modules/tasks/services/source-health";

/** Where "How to share" goes: Notion's own page on giving a connection access to a page. */
export const NOTION_SHARE_HELP = "https://www.notion.com/help/add-and-manage-connections-with-the-api";

export interface SourceHealthBannerProps {
  /** The source's name, which names the banner for a screen reader. */
  name: string;
  health: HealthView;
  onRetry: () => void;
  onReconnect?: () => void;
  onRemap?: () => void;
}

/**
 * The list banner of `SOURCES 06`: shown only while a source is not healthy, above rows that stay
 * — the words say what is wrong, the one button what fixes it.
 */
export function SourceHealthBanner({ name, health, onRetry, onReconnect, onRemap }: SourceHealthBannerProps) {
  if (!health.banner) return null;
  const act: Record<HealthAction, (() => void) | undefined> = {
    retry: onRetry,
    reconnect: onReconnect,
    how_to_share: () => void openExternalLink(NOTION_SHARE_HELP),
    remap: onRemap,
  };
  const onAction = health.action ? act[health.action] : undefined;
  return (
    <div className="tk-health-banner" role="status" aria-label={name} data-tone={health.tone}>
      <span className="tk-health-dot" data-tone={health.tone} aria-hidden />
      <p className="tk-health-text">{health.banner}</p>
      {health.action && onAction ? (
        <button type="button" className="tk-button tk-health-action" onClick={onAction}>
          {HEALTH_ACTION_LABELS[health.action]}
        </button>
      ) : null}
    </div>
  );
}

/** The nav row's dot: the same tone as the banner, so a glance at the nav says the same thing. */
export function SourceHealthDot({ health }: { health: HealthView | undefined }) {
  if (!health) return null;
  return <span className="tk-health-dot" data-tone={health.tone} data-state={health.state} aria-hidden />;
}

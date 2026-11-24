"use client";
import { Download, RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { useLotusSettings } from "../lotus-settings-context";
import { checkAppUpdateIfStale, installAppUpdate, useAppUpdate } from "../services/app-update";
import { checkCliUpdatesIfStale, isActionable, RECHECK_MS, useCliUpdates } from "../services/cli-updates";

/**
 * Title-bar update control (after bb): one quiet ring, empty when there is nothing to do. Left half
 * restarts into a downloaded Lotus build; right half names the CLI updates and opens Settings › Updates.
 */
export function UpdatePill() {
  const { phase, version } = useAppUpdate();
  const { items, running, results } = useCliUpdates();
  const { openSettings } = useLotusSettings();

  useEffect(() => {
    checkCliUpdatesIfStale();
    checkAppUpdateIfStale(0);
    const cliTimer = setInterval(() => checkCliUpdatesIfStale(), RECHECK_MS);
    const appTimer = setInterval(() => checkAppUpdateIfStale(APP_RECHECK_MS), APP_RECHECK_MS);
    const onFocus = () => checkAppUpdateIfStale(APP_FOCUS_MIN_MS);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(cliTimer);
      clearInterval(appTimer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const appReady = phase === "ready" || phase === "installing";
  const failedIds = Object.entries(results).filter(([, r]) => !r.ok).map(([id]) => id);
  const ids = [...new Set([...(running ? [running] : []), ...failedIds, ...(items ?? []).filter(isActionable).map((i) => i.id)])];
  if (!appReady && ids.length === 0) return null;

  const name = (id: string) => items?.find((i) => i.id === id)?.name ?? id;
  const cliLabel = running
    ? `Updating ${name(running)}`
    : failedIds.length > 0
      ? `Update failed: ${failedIds.map(name).join(", ")}`
      : `Updates available: ${ids.map(name).join(", ")}`;

  return (
    <span className="inline-flex h-[26px] items-center rounded-full border border-(--border-sub) ds-t-meta text-(--fg-muted)">
      {appReady ? (
        <button
          type="button"
          className={APP_HALF}
          onClick={() => void installAppUpdate()}
          disabled={phase === "installing"}
          aria-label={`Restart to update to ${version}`}
          title={`Lotus ${version} is downloaded. Restart to finish updating.`}
        >
          <RotateCcw size={12} className={phase === "installing" ? "animate-spin" : undefined} aria-hidden />
          {phase === "installing" ? "Restarting…" : "Restart to update"}
          {version ? <span className="font-mono tabular-nums opacity-70">{version}</span> : null}
          {/* one-shot attention ping so the pill is noticed when it appears, then stays still */}
          <span className="relative ml-0.5 flex h-1.5 w-1.5" aria-hidden>
            <span className="absolute inset-0 rounded-full bg-(--accent-fg) opacity-60 motion-safe:animate-[ping_1.2s_ease-out_3]" />
            <span className="relative h-1.5 w-1.5 rounded-full bg-(--accent-fg)" />
          </span>
        </button>
      ) : null}
      {appReady && ids.length > 0 ? <span className="h-3 w-px bg-(--border-sub)" aria-hidden /> : null}
      {ids.length > 0 ? (
        <button type="button" className={HALF} onClick={() => openSettings({ section: "agents" })} aria-label={cliLabel} title={cliLabel}>
          {running ? (
            <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-(--border-sub) border-t-(--accent)" aria-hidden />
          ) : failedIds.length > 0 ? (
            <span className="h-1.5 w-1.5 rounded-full bg-(--ds-danger)" aria-hidden />
          ) : (
            <Download size={13} aria-hidden />
          )}
          {running ? `Updating ${name(running)}` : failedIds.length > 0 ? "Update failed" : `${ids.length} update${ids.length === 1 ? "" : "s"}`}
        </button>
      ) : null}
    </span>
  );
}

const HALF =
  "inline-flex h-full items-center gap-1.5 rounded-full px-2.5 font-medium transition-colors hover:bg-(--bg-hover) hover:text-(--fg) disabled:opacity-60";
/** The app restart is the one action that needs noticing: filled accent, not the quiet ring. */
const APP_HALF =
  "inline-flex h-full items-center gap-1.5 rounded-full bg-(--accent) px-2.5 font-medium text-(--accent-fg) transition-[filter] hover:brightness-110 disabled:opacity-60";
const APP_RECHECK_MS = 60 * 60 * 1000;
/** Window focus re-checks too, but not more often than this (bb's numbers). */
const APP_FOCUS_MIN_MS = 15 * 60 * 1000;

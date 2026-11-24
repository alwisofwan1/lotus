"use client";

import { useCallback, useEffect, useState } from "react";
import { getSettings, saveSettings } from "@/lib/tauri-api";
import { isTauri } from "@/lib/tauri/runtime";
import {
  emitLotusSettingsChanged,
  LOTUS_SETTINGS_CHANGED_EVENT,
  readLotusSettingsChangedDetail,
} from "@/modules/settings/services/settings-events";
import {
  resolveTicketSources,
  withGitHubSource,
  withNotionSource,
  withObsidianSource,
  withoutSource,
  type ObsidianSourceConfig,
  type TicketSourceConfig,
} from "@/modules/tasks/services/ticket-source-settings";
import type { GitHubSourceConfig } from "@/modules/tasks/services/github-issues-source";
import type { NotionSourceConfig } from "@/modules/tasks/services/notion-source";
import type { ClaudeSettings } from "@/modules/settings/types";

/**
 * The configured ticket sources, and the connected vault's path, read from and written to
 * `~/.claude/settings.json` (`ticketSources` + `vault.path`, see `ticket-source-settings.ts`).
 *
 * It is a fact about this machine, so it lives beside every other Settings value rather than in
 * shell layout preferences — that store is localStorage and says of itself that it holds no paths.
 *
 * Writes go straight to disk rather than waiting for a Save button: this is reached from the
 * tracker, where there is no such button and no page to leave, and a connection that needed
 * saving elsewhere would be a promise the surface cannot keep.
 */
export function useVaultPath(): {
  path: string;
  /** Every configured source, in nav order: at most one vault, and any number of Notion databases. */
  sources: TicketSourceConfig[];
  connect: (path: string) => void;
  disconnect: () => void;
  /** Adds a Notion database, or replaces it when it is already a source. */
  addNotionSource: (source: NotionSourceConfig) => void;
  /** Adds a GitHub repo. A repo that is already a source is left as it is (PLAN G2). */
  addGitHubSource: (source: GitHubSourceConfig) => void;
  /** Removes a Notion or GitHub source. The vault is removed with `disconnect`. */
  removeSource: (id: string) => void;
} {
  const [sources, setSources] = useState<TicketSourceConfig[]>([]);
  const path = sources.find(isObsidian)?.path ?? "";

  /*
    Every write is "apply one change to the settings": on screen at once, then on disk. The change
    is applied twice — to what is on screen, and to what the file says now — because another
    surface may have written the file in between, and its keys must survive this write.

    `whenSaved` shows the change only once it is on disk. A GitHub source needs that: its first sync
    starts the moment it is on screen, and Rust reads the source from the file — before the write
    lands it answered "is not a GitHub ticket source" (found 2026-10-04, the first add of a repo).
  */
  const apply = useCallback((change: (settings: ClaudeSettings) => ClaudeSettings, { whenSaved = false } = {}) => {
    const show = () => setSources((current) => resolveTicketSources(change(listedSettings(current))));
    if (!isTauri()) {
      show();
      return;
    }
    if (!whenSaved) show();
    void getSettings()
      .then(async (data) => {
        const merged = change(data as ClaudeSettings) as unknown as Record<string, unknown>;
        await saveSettings(merged);
        if (whenSaved) show();
        emitLotusSettingsChanged(merged);
      })
      .catch(() => {
        /* the value stays on screen (or, `whenSaved`, never reaches it); the next read corrects it */
      });
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void getSettings()
      .then((data) => {
        if (!cancelled) setSources(resolveTicketSources(data as ClaudeSettings));
      })
      .catch(() => {
        /* no vault, which is a perfectly good state */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Someone may still change it from another surface; the row must not go stale behind them.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: Event) => {
      const detail = readLotusSettingsChangedDetail(event);
      if (!detail) return;
      setSources(resolveTicketSources(detail.settings as ClaudeSettings));
    };
    window.addEventListener(LOTUS_SETTINGS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(LOTUS_SETTINGS_CHANGED_EVENT, handler);
  }, []);

  const write = useCallback(
    (next: string) => apply((settings) => withObsidianSource(settings, next || null)),
    [apply],
  );

  return {
    path,
    sources,
    connect: write,
    disconnect: useCallback(() => write(""), [write]),
    addNotionSource: useCallback((source: NotionSourceConfig) => apply((settings) => withNotionSource(settings, source)), [apply]),
    addGitHubSource: useCallback((source: GitHubSourceConfig) => apply((settings) => withGitHubSource(settings, source), { whenSaved: true }), [apply]),
    removeSource: useCallback((id: string) => apply((settings) => withoutSource(settings, id)), [apply]),
  };
}

/** The sources on screen, as the settings they were read from — enough to apply one change to. */
function listedSettings(sources: readonly TicketSourceConfig[]): ClaudeSettings {
  const vault = sources.find(isObsidian);
  return {
    // A vault entry is only its id and kind (its folder is `vault.path`); a Notion or GitHub entry is whole.
    ticketSources: sources.map((source) => (source.kind === "obsidian" ? { id: source.id, kind: source.kind } : source)),
    vault: { path: vault?.path ?? "" },
  };
}

function isObsidian(source: TicketSourceConfig): source is ObsidianSourceConfig {
  return source.kind === "obsidian";
}

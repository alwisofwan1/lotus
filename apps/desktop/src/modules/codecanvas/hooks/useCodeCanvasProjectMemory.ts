"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  codecanvasMemoryArchive,
  codecanvasMemoryList,
  codecanvasMemoryRestore,
  codecanvasMemorySearch,
  codecanvasMemorySetPinned,
  codecanvasMemoryWrite,
  type CodeCanvasMemoryItem,
} from "@/lib/tauri/codecanvas";
import { isTauri, loadTauriCore } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import { buildProjectMemoryBriefBlock, buildProjectMemoryPromptBlock, buildRelevantMemoryQueries, dedupeMemoryItems, type CodeCanvasMemoryContext } from "../services/memory/codecanvas-memory-read-model";

/** Emitted by the Rust MCP memory route whenever an agent writes/archives project memory. */
const MEMORY_UPDATED_EVENT = "codecanvas://memory-updated";

export interface UseCodeCanvasProjectMemoryResult {
  items: CodeCanvasMemoryItem[];
  loading: boolean;
  error: string | null;
  /** Whether the current view includes archived rows. */
  includeArchived: boolean;
  setIncludeArchived: (includeArchived: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  search: (query: string) => Promise<void>;
  write: (input: { kind: string; body: string; title?: string; tags?: string[] }) => Promise<void>;
  archive: (itemId: string) => Promise<void>;
  restore: (itemId: string) => Promise<void>;
  setPinned: (itemId: string, pinned: boolean) => Promise<void>;
}

const PAGE_LIMIT = 40;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useCodeCanvasProjectMemory(projectId: string | null | undefined): UseCodeCanvasProjectMemoryResult {
  const [items, setItems] = useState<CodeCanvasMemoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includeArchived, setIncludeArchivedState] = useState(false);

  // Read through a ref so refresh/search keep a stable identity while still seeing the live view mode
  // (the archived toggle must not re-run the mount effect or re-subscribe the MCP listener).
  const includeArchivedRef = useRef(includeArchived);
  includeArchivedRef.current = includeArchived;

  const load = useCallback(async (archived: boolean) => {
    if (!projectId) { setItems([]); return; }
    setLoading(true);
    setError(null);
    try {
      setItems(await codecanvasMemoryList({ projectId, includeArchived: archived, limit: PAGE_LIMIT }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const refresh = useCallback(async () => {
    await load(includeArchivedRef.current);
  }, [load]);

  const setIncludeArchived = useCallback(async (next: boolean) => {
    setIncludeArchivedState(next);
    includeArchivedRef.current = next;
    await load(next);
  }, [load]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Live-refresh when an agent writes/archives memory via MCP for this project, so the human panel
  // stays in sync with agent activity without polling. Guarded so browser/test envs are a no-op.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!projectId || !isTauri()) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    (async () => {
      await loadTauriCore();
      const { listen } = await import("@tauri-apps/api/event");
      const next = await listen<{ projectId?: string }>(MEMORY_UPDATED_EVENT, (event) => {
        if (event.payload?.projectId === projectId) void refreshRef.current();
      });
      if (disposed) { safeTauriUnlisten(next); return; }
      unlisten = next;
    })();
    return () => { disposed = true; safeTauriUnlisten(unlisten); };
  }, [projectId]);

  const search = useCallback(async (query: string) => {
    if (!projectId) return;
    const text = query.trim();
    if (!text) { await refresh(); return; }
    setLoading(true);
    setError(null);
    try {
      const results = await codecanvasMemorySearch({
        projectId,
        query: text,
        includeArchived: includeArchivedRef.current,
        limit: PAGE_LIMIT,
      });
      setItems(results.map((result) => result.item));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [projectId, refresh]);

  const write = useCallback(async (input: { kind: string; body: string; title?: string; tags?: string[] }) => {
    if (!projectId) return;
    const body = input.body.trim();
    if (!body) return;
    await codecanvasMemoryWrite({
      projectId,
      kind: input.kind,
      body,
      title: input.title?.trim() || undefined,
      tags: input.tags ?? [],
      source: "human",
      actorKind: "human",
    });
    await refresh();
  }, [projectId, refresh]);

  const archive = useCallback(async (itemId: string) => {
    if (!projectId) return;
    try {
      await codecanvasMemoryArchive(projectId, itemId);
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    await refresh();
  }, [projectId, refresh]);

  const restore = useCallback(async (itemId: string) => {
    if (!projectId) return;
    try {
      await codecanvasMemoryRestore(projectId, itemId);
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    await refresh();
  }, [projectId, refresh]);

  const setPinned = useCallback(async (itemId: string, pinned: boolean) => {
    if (!projectId) return;
    try {
      await codecanvasMemorySetPinned(projectId, itemId, pinned);
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    await refresh();
  }, [projectId, refresh]);

  return {
    items,
    loading,
    error,
    includeArchived,
    setIncludeArchived,
    refresh,
    search,
    write,
    archive,
    restore,
    setPinned,
  };
}

const EMPTY_BLOCKS = { prompt: "", brief: "" };

/**
 * Both renderings of project memory for one agent: `prompt` for claude-family runners (invisible
 * system prompt) and `brief` for runners that have no system-prompt flag, where the text is typed
 * into the pane. Runners without the flag would otherwise work in a project blind to its rules.
 */
export function useCodeCanvasAgentMemoryPrompt(context: CodeCanvasMemoryContext) {
  const queries = useMemo(() => buildRelevantMemoryQueries(context), [context.projectId, context.nodeId, context.runId, context.assignmentKey, context.sessionId, context.limit]);
  const [blocks, setBlocks] = useState(EMPTY_BLOCKS);
  const [loading, setLoading] = useState(queries.length > 0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (queries.length === 0) {
        if (!cancelled) { setBlocks(EMPTY_BLOCKS); setLoading(false); }
        return;
      }
      if (!cancelled) setLoading(true);
      try {
        const groups = await Promise.all(queries.map((query) => codecanvasMemoryList(query)));
        const items = dedupeMemoryItems(groups.flat());
        const now = Date.now();
        if (!cancelled) {
          setBlocks({
            prompt: buildProjectMemoryPromptBlock(items, { now }),
            brief: buildProjectMemoryBriefBlock(items, { now }),
          });
        }
      } catch {
        if (!cancelled) setBlocks(EMPTY_BLOCKS);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [queries]);

  return { prompt: blocks.prompt, brief: blocks.brief, loading };
}

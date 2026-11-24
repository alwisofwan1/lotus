import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useNotionSources } from "@/modules/tasks/hooks/useNotionSources";
import type { NotionRow, NotionSourceClient, NotionSourceConfig, SourceSync } from "@/modules/tasks/services/notion-source";

const config: NotionSourceConfig = {
  id: "notion-abc",
  kind: "notion",
  name: "Orbit board",
  dataSourceId: "abc",
  url: null,
  mapping: { title: "title", key: "id", status: "st", assignee: null, labels: null, parent: null },
  statuses: {
    options: [{ id: "todo", name: "Todo", color: null }, { id: "done", name: "Released", color: null }],
    groups: [
      { id: "g1", name: "To-do", optionIds: ["todo"] },
      { id: "g2", name: "In progress", optionIds: [] },
      { id: "g3", name: "Complete", optionIds: ["done"] },
    ],
  },
  permission: "read_only",
};

const row: NotionRow = {
  pageId: "p1",
  url: "https://www.notion.so/p1",
  key: "TKT-1",
  title: "One",
  status: "todo",
  assignees: [], assigneeIds: [],
  labels: [],
  parents: [],
  createdTime: "2026-09-01T10:00:00.000Z",
  lastEditedTime: "2026-09-01T10:00:00.000Z",
};

const SYNCED = Date.UTC(2026, 8, 28, 9, 30);

function synced(over: Partial<SourceSync> = {}): SourceSync {
  return { rows: [row], syncedAtMs: SYNCED, reconciledAtMs: SYNCED, complete: true, schema: null, health: { state: "healthy" }, ...over };
}

function client(result: SourceSync | Error | ((call: number) => SourceSync)): NotionSourceClient {
  let calls = 0;
  return {
    search: vi.fn(async () => []),
    describe: vi.fn(async () => Promise.reject("unused")),
    read: vi.fn(async () => {
      calls += 1;
      if (result instanceof Error) return Promise.reject(result.message);
      return typeof result === "function" ? result(calls) : result;
    }),
    forget: vi.fn(async () => undefined),
    write: vi.fn(),
    trash: vi.fn(),
    create: vi.fn(),
    writeBody: vi.fn(),
    pageMarkdown: vi.fn(),
  };
}

const CONFIGS = [config];

describe("Notion databases as ticket sources", () => {
  it("reads each source in full when it appears, and shows its rows in its own project and words", async () => {
    const notion = client(synced());
    const { result } = renderHook(() => useNotionSources(CONFIGS, { client: notion }));

    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    expect(notion.read).toHaveBeenCalledWith("notion-abc", "abc", config.mapping, { full: true });
    expect(result.current.tasks[0]).toMatchObject({ id: "p1", projectId: "notion-abc", key: "TKT-1", status: "todo" });
    const project = result.current.projects[0];
    expect(project).toMatchObject({ id: "notion-abc", name: "Orbit board", source: { kind: "notion" } });
    expect(project.vocabulary.open).toEqual(["todo"]);
    expect(project.capabilities).toMatchObject({ holdsTasks: false, editRows: false });
    expect(project.source?.syncLine).toMatch(/^Notion · synced /);
    expect(project.source?.health?.state).toBe("healthy");
    expect(result.current.rowOf("notion-abc", "p1")).toEqual(row);
  });

  it("keeps the last good copy on screen when Notion cannot be reached, and says it is offline", async () => {
    const notion = client(synced({ health: { state: "offline", message: "Notion could not be reached" } }));
    const { result } = renderHook(() => useNotionSources(CONFIGS, { client: notion }));

    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    expect(result.current.projects[0].source?.syncLine).toMatch(/^Notion · offline, showing /);
    expect(result.current.projects[0].source?.health?.action).toBe("retry");
  });

  it("says when the token no longer works", async () => {
    const notion = client(synced({ rows: [], syncedAtMs: null, health: { state: "lost_access", why: "token" } }));
    const { result } = renderHook(() => useNotionSources(CONFIGS, { client: notion }));
    await waitFor(() => expect(result.current.projects[0].source?.syncLine).toBe("Notion · no access"));
  });

  it("keeps the rows it has when the command itself fails", async () => {
    const notion = client((call) => {
      if (call === 1) return synced();
      throw new Error("the command went away");
    });
    const { result } = renderHook(() => useNotionSources(CONFIGS, { client: notion }));
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.projects[0].source?.health?.state).toBe("failed"));
    expect(result.current.tasks).toHaveLength(1);
  });

  it("follows a status Notion added, without a remap: the board's words come from the fields last read", async () => {
    const withBlocked = {
      id: "abc",
      title: "Orbit board",
      url: null,
      properties: [
        {
          id: "st",
          name: "Status",
          kind: "status",
          uniquePrefix: null,
          relationTarget: null,
          status: {
            options: [...config.statuses!.options, { id: "blocked", name: "Blocked", color: null }],
            groups: [
              { id: "g1", name: "To-do", optionIds: ["todo"] },
              { id: "g2", name: "In progress", optionIds: ["blocked"] },
              { id: "g3", name: "Complete", optionIds: ["done"] },
            ],
          },
        },
      ],
    };
    const notion = client(synced({ schema: withBlocked }));
    const { result } = renderHook(() => useNotionSources(CONFIGS, { client: notion }));

    await waitFor(() => expect(result.current.projects[0].vocabulary.labels.blocked).toBe("Blocked"));
    expect(result.current.projects[0].vocabulary.open).toContain("blocked");
  });

  it("a new mapping reads the board again in full, and the source says it is healthy", async () => {
    const notion = client((call) =>
      call === 1 ? synced({ health: { state: "fields_changed", fields: [{ field: "status", nowKind: null }] } }) : synced(),
    );
    const { result, rerender } = renderHook(({ configs }) => useNotionSources(configs, { client: notion }), {
      initialProps: { configs: CONFIGS },
    });
    await waitFor(() => expect(result.current.projects[0].source?.health?.state).toBe("fields_changed"));

    rerender({ configs: [{ ...config, mapping: { ...config.mapping, status: "st2" } }] });

    await waitFor(() => expect(result.current.projects[0].source?.health?.state).toBe("healthy"));
    expect(notion.read).toHaveBeenLastCalledWith("notion-abc", "abc", { ...config.mapping, status: "st2" }, { full: true });
  });

  it("a new mapping saved while a sync is running is read once that sync ends, not dropped", async () => {
    let finish: (value: SourceSync) => void = () => undefined;
    const notion = client(synced());
    let calls = 0;
    notion.read = vi.fn(() => {
      calls += 1;
      return calls === 1 ? new Promise<SourceSync>((resolve) => (finish = resolve)) : Promise.resolve(synced());
    });
    const { result, rerender } = renderHook(({ configs }) => useNotionSources(configs, { client: notion }), {
      initialProps: { configs: CONFIGS },
    });
    const remapped = { ...config.mapping, status: "st2" };

    rerender({ configs: [{ ...config, mapping: remapped }] });
    expect(notion.read).toHaveBeenCalledTimes(1);
    act(() => finish(synced({ health: { state: "fields_changed", fields: [{ field: "status", nowKind: null }] } })));

    await waitFor(() => expect(notion.read).toHaveBeenCalledTimes(2));
    expect(notion.read).toHaveBeenLastCalledWith("notion-abc", "abc", remapped, { full: true });
    await waitFor(() => expect(result.current.projects[0].source?.health?.state).toBe("healthy"));
  });

  it("a ticket trashed while a sync runs does not come back when that sync lands", async () => {
    let finish: (value: SourceSync) => void = () => undefined;
    const notion = client(synced());
    let calls = 0;
    notion.read = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve(synced()) : new Promise<SourceSync>((resolve) => (finish = resolve));
    });
    const { result } = renderHook(() => useNotionSources(CONFIGS, { client: notion }));
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    act(() => result.current.refresh()); // a sync starts, and reads the board as it was
    act(() => result.current.removeRow("notion-abc", "p1")); // then the ticket is trashed
    expect(result.current.tasks).toHaveLength(0);

    await act(async () => finish(synced({ syncedAtMs: Date.now() - 1_000 }))); // read before the trash
    expect(result.current.tasks).toHaveLength(0);
  });

  it("a write's answer is not undone by an older sync landing after it", async () => {
    let finish: (value: SourceSync) => void = () => undefined;
    const notion = client(synced());
    let calls = 0;
    notion.read = vi.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve(synced()) : new Promise<SourceSync>((resolve) => (finish = resolve));
    });
    const { result } = renderHook(() => useNotionSources(CONFIGS, { client: notion }));
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));

    act(() => result.current.refresh());
    act(() => result.current.applyRow("notion-abc", { ...row, title: "Saved in Notion" }));
    await act(async () => finish(synced({ syncedAtMs: Date.now() - 1_000 })));

    expect(result.current.rowOf("notion-abc", "p1")?.title).toBe("Saved in Notion");
  });

  it("has nothing to show, and reads nothing, with no source configured", () => {
    const notion = client(new Error("unused"));
    const { result } = renderHook(() => useNotionSources([], { client: notion }));
    expect(result.current.projects).toEqual([]);
    expect(notion.read).not.toHaveBeenCalled();
  });
});

describe("keeping a Notion source fresh without a click (PLAN S24)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(SYNCED);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function settle() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("syncs every minute while Tasks is open and the window has focus", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const notion = client(synced());
    renderHook(() => useNotionSources(CONFIGS, { client: notion, live: true }));
    await settle();
    expect(notion.read).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(notion.read).toHaveBeenCalledTimes(2);
    expect(notion.read).toHaveBeenLastCalledWith("notion-abc", "abc", config.mapping, { full: false });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(notion.read).toHaveBeenCalledTimes(3);
  });

  it("does not poll while Tasks is closed", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const notion = client(synced());
    renderHook(() => useNotionSources(CONFIGS, { client: notion, live: false }));
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(notion.read).toHaveBeenCalledTimes(1);
  });

  it("does not poll while the window is in the background, and syncs once when it comes back", async () => {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const notion = client(synced());
    renderHook(() => useNotionSources(CONFIGS, { client: notion, live: true }));
    await settle();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(notion.read).toHaveBeenCalledTimes(1);

    focus.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(notion.read).toHaveBeenCalledTimes(2);
  });

  it("opening Tasks syncs at once", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const notion = client(synced());
    const { rerender } = renderHook(({ live }) => useNotionSources(CONFIGS, { client: notion, live }), {
      initialProps: { live: false },
    });
    await settle();
    expect(notion.read).toHaveBeenCalledTimes(1);

    rerender({ live: true });
    await settle();
    expect(notion.read).toHaveBeenCalledTimes(2);
  });

  it("when Notion asks to slow down, the next sync waits for the time it named", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const notion = client((call) =>
      call === 1 ? synced({ health: { state: "slowed_down", retryAtMs: SYNCED + 90_000 } }) : synced(),
    );
    const { result } = renderHook(() => useNotionSources(CONFIGS, { client: notion, live: true }));
    await settle();
    expect(result.current.projects[0].source?.health?.state).toBe("slowed_down");

    // The minute's poll is skipped: Notion said 90 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(notion.read).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(notion.read).toHaveBeenCalledTimes(2);
    expect(result.current.projects[0].source?.health?.state).toBe("healthy");
  });
});

import { describe, expect, it, vi } from "vitest";
import { routeSelectionToThread } from "@/modules/workspace-shell/services/selection-routing";
import { takeThreadDraft } from "@/modules/codespace/state/thread-draft-inbox";
import type { Workspace } from "@/modules/codespace/components/types";

const ws = (cells: Array<{ id: string; type: string; sessionId?: string; thread?: { id: string | null } }>) =>
  ({ id: "ws-1", cwd: "/repo", cells }) as unknown as Workspace;

describe("routeSelectionToThread", () => {
  it("fills the Thread used last", () => {
    const addThreadPane = vi.fn();
    const result = routeSelectionToThread({
      workspace: ws([
        { id: "ed-1", type: "workbench" },
        { id: "t-1", type: "chat", sessionId: "s-1" },
        { id: "t-2", type: "chat", sessionId: "s-2" },
      ]),
      preferredThreadId: "t-2",
      sourceCellId: "ed-1",
      text: "src/x.ts:10-12",
      addThreadPane,
    });

    expect(result).toEqual({ ok: true, paneId: "t-2", created: false });
    expect(takeThreadDraft("s-2")).toBe("src/x.ts:10-12");
    expect(takeThreadDraft("s-1")).toBeNull();
    expect(addThreadPane).not.toHaveBeenCalled();
  });

  it("fills a new-chat pane under the pane's id, thread or not (07d)", () => {
    const result = routeSelectionToThread({
      workspace: ws([{ id: "ed-1", type: "workbench" }, { id: "t-new", type: "chat", sessionId: "", thread: { id: null } }]),
      preferredThreadId: null,
      sourceCellId: "ed-1",
      text: "src/x.ts:3",
      addThreadPane: vi.fn(),
    });
    expect(result).toEqual({ ok: true, paneId: "t-new", created: false });
    expect(takeThreadDraft("t-new")).toBe("src/x.ts:3");
  });

  it("uses the first Thread when none was used yet, or the one used is gone", () => {
    const result = routeSelectionToThread({
      workspace: ws([{ id: "ed-1", type: "workbench" }, { id: "t-1", type: "chat", sessionId: "s-1" }]),
      preferredThreadId: "t-closed",
      sourceCellId: "ed-1",
      text: "x",
      addThreadPane: vi.fn(),
    });
    expect(result).toEqual({ ok: true, paneId: "t-1", created: false });
    expect(takeThreadDraft("s-1")).toBe("x");
  });

  it("opens one Thread beside the Editor when there is none, and leaves the draft for it", () => {
    const addThreadPane = vi.fn(() => ({ paneId: "t-new", sessionId: "s-new" }));
    const result = routeSelectionToThread({
      workspace: ws([{ id: "ed-1", type: "workbench" }, { id: "term-1", type: "terminal" }]),
      preferredThreadId: null,
      sourceCellId: "ed-1",
      text: "src/x.ts:3",
      addThreadPane,
    });
    expect(result).toEqual({ ok: true, paneId: "t-new", created: true });
    expect(addThreadPane).toHaveBeenCalledTimes(1);
    expect(addThreadPane).toHaveBeenCalledWith("ed-1");
    expect(takeThreadDraft("s-new")).toBe("src/x.ts:3");
  });

  it("says so when no Thread can be opened", () => {
    expect(routeSelectionToThread({
      workspace: ws([{ id: "ed-1", type: "workbench" }]),
      preferredThreadId: null,
      sourceCellId: "ed-1",
      text: "x",
      addThreadPane: () => null,
    })).toEqual({ ok: false, reason: "A new Thread could not be opened here." });
  });
});

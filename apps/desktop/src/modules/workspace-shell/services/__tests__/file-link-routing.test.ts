import { describe, expect, it, vi } from "vitest";
import { routeFileLink } from "@/modules/workspace-shell/services/file-link-routing";
import { takeWorkbenchOpen } from "@/modules/codespace/services/workbench-open";
import type { Workspace } from "@/modules/codespace/components/types";

const ws = (cells: Array<{ id: string; type: string }>) =>
  ({ id: "ws-1", cwd: "/repo", cells }) as unknown as Workspace;

describe("routeFileLink", () => {
  it("opens in the Editor pane used last when there is one", () => {
    const addEditorPane = vi.fn();
    const result = routeFileLink({
      workspace: ws([{ id: "ed-1", type: "workbench" }, { id: "ed-2", type: "workbench" }]),
      preferredEditorId: "ed-2",
      sourceCellId: "chat-1",
      link: { path: "src/a.ts", startLine: 10, endLine: 12 },
      addEditorPane,
    });

    expect(result).toEqual({ ok: true, cellId: "ed-2" });
    expect(takeWorkbenchOpen("ed-2")).toEqual({ path: "/repo/src/a.ts", startLine: 10, endLine: 12 });
    expect(addEditorPane).not.toHaveBeenCalled();
  });

  it("uses the first Editor pane when none was used yet", () => {
    const result = routeFileLink({
      workspace: ws([{ id: "chat-1", type: "chat" }, { id: "ed-1", type: "workbench" }]),
      preferredEditorId: null,
      sourceCellId: "chat-1",
      link: { path: "a.ts" },
      addEditorPane: vi.fn(),
    });

    expect(result).toEqual({ ok: true, cellId: "ed-1" });
    expect(takeWorkbenchOpen("ed-1")).toEqual({ path: "/repo/a.ts" });
  });

  it("opens one Editor pane when the workspace has none", () => {
    const addEditorPane = vi.fn().mockReturnValue("ed-new");
    const result = routeFileLink({
      workspace: ws([{ id: "chat-1", type: "chat" }]),
      preferredEditorId: null,
      sourceCellId: "chat-1",
      link: { path: "a.ts", startLine: 3, endLine: 3 },
      addEditorPane,
    });

    expect(addEditorPane).toHaveBeenCalledTimes(1);
    expect(addEditorPane).toHaveBeenCalledWith("chat-1");
    expect(result).toEqual({ ok: true, cellId: "ed-new" });
    expect(takeWorkbenchOpen("ed-new")).toEqual({ path: "/repo/a.ts", startLine: 3, endLine: 3 });
  });

  it("refuses a path outside the workspace and opens nothing", () => {
    const addEditorPane = vi.fn();
    const result = routeFileLink({
      workspace: ws([]),
      preferredEditorId: null,
      sourceCellId: null,
      link: { path: "../secret.txt" },
      addEditorPane,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/outside the workspace/);
    expect(addEditorPane).not.toHaveBeenCalled();
  });
});

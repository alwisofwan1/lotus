import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutTemplate } from "@/modules/codespace/components/types";
import { useCodeSpaceWorkspaceManager } from "@/modules/codespace/hooks/useCodeSpaceWorkspaceManager";
import { buildCodeSpaceWebviewLabel, destroyWebviewPane } from "@/modules/codespace/services/webview-registry";

const destroyWebviewPaneMock = vi.hoisted(() => vi.fn((label: string) => {
  void label;
  return Promise.resolve();
}));

vi.mock("@/modules/codespace/services/webview-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/codespace/services/webview-registry")>();
  return {
    ...actual,
    destroyWebviewPane: destroyWebviewPaneMock,
    destroyCodeSpaceWorkspaceWebviews: vi.fn((
      workspaceId: string,
      cells: Array<{ id: string; type: string; tabs?: Array<{ id: string; kind: string }> }>,
      options: { includeRightPanel?: boolean } = {},
    ) => {
      if (options.includeRightPanel) {
        destroyWebviewPaneMock(actual.buildCodeSpaceWebviewLabel("right-panel", workspaceId, "browser"));
      }

      for (const cell of cells) {
        if (cell.type === "browser") {
          destroyWebviewPaneMock(actual.buildCodeSpaceWebviewLabel("grid", workspaceId, cell.id));
        }
        if (cell.type === "workbench") {
          for (const tab of cell.tabs ?? []) {
            if (tab.kind === "url") {
              destroyWebviewPaneMock(actual.buildCodeSpaceWebviewLabel("workbench", cell.id, tab.id));
            }
          }
        }
      }
    }),
  };
});

const twoPaneTemplate: LayoutTemplate = {
  id: "pair",
  name: "Pair",
  label: "Pair",
  description: "Two panes",
  rows: 1,
  cols: 2,
  sessions: 2,
};

describe("useCodeSpaceWorkspaceManager browser webviews", () => {
  beforeEach(() => {
    vi.mocked(destroyWebviewPane).mockClear();
  });

  it("persists browser pane URL changes in workspace state", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(
        twoPaneTemplate,
        "/tmp/project-browser",
        ["", ""],
        "Browser",
        ["browser", "terminal"],
      );
    });

    const workspaceId = result.current.workspaces[0]?.id;
    const browserCell = result.current.workspaces[0]?.cells.find((cell) => cell.type === "browser");
    expect(workspaceId).toBeTruthy();
    expect(browserCell?.id).toBeTruthy();

    act(() => {
      result.current.updateBrowserCellUrl(workspaceId!, browserCell!.id, "https://example.com/dashboard");
    });

    expect(result.current.workspaces[0]?.cells.find((cell) => cell.id === browserCell!.id)).toEqual(
      expect.objectContaining({
        type: "browser",
        url: "https://example.com/dashboard",
      }),
    );
  });

  it("destroys native browser webviews only when their pane is removed", () => {
    const { result } = renderHook(() => useCodeSpaceWorkspaceManager());

    act(() => {
      result.current.createWorkspace(
        twoPaneTemplate,
        "/tmp/project-browser",
        ["", ""],
        "Browser",
        ["browser", "terminal"],
      );
    });

    const workspaceId = result.current.workspaces[0]?.id;
    const browserCell = result.current.workspaces[0]?.cells.find((cell) => cell.type === "browser");
    expect(workspaceId).toBeTruthy();
    expect(browserCell?.id).toBeTruthy();

    act(() => {
      result.current.removePane(workspaceId!, browserCell!.id);
    });

    expect(destroyWebviewPane).toHaveBeenCalledWith(
      buildCodeSpaceWebviewLabel("grid", workspaceId!, browserCell!.id),
    );
  });
});

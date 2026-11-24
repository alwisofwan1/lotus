import { describe, expect, it } from "vitest";
import type { WorkspacePaneLayout } from "@/modules/codespace/components/types";
import {
  resolveTerminalV2RemovePaneLayout,
  resolveTerminalV2SplitPaneLayout,
  shouldPreserveLegacyGridTracksForTerminalV2,
} from "../terminal-v2-workspace-layout-mutations";

const paneLayout: WorkspacePaneLayout = {
  mode: "grid",
  focusCellId: null,
  terminalV2Layout: {
    root: { kind: "leaf", paneId: "pane-1" },
    activePaneId: "pane-1",
  },
};

describe("terminal-v2-workspace-layout-mutations", () => {
  it("reports whether V2 layout metadata owns layout tracks", () => {
    expect(shouldPreserveLegacyGridTracksForTerminalV2(paneLayout)).toBe(true);
    expect(shouldPreserveLegacyGridTracksForTerminalV2({ mode: "grid", focusCellId: null })).toBe(false);
    expect(shouldPreserveLegacyGridTracksForTerminalV2(undefined)).toBe(false);
  });

  it("returns undefined split layout when workspace has no V2 metadata", () => {
    expect(resolveTerminalV2SplitPaneLayout({ mode: "grid", focusCellId: null }, "pane-1", "pane-2", "horizontal")).toBeUndefined();
  });

  it("splits the active V2 pane when no explicit source pane is provided", () => {
    expect(resolveTerminalV2SplitPaneLayout(paneLayout, undefined, "pane-2", "horizontal")?.terminalV2Layout).toEqual({
      root: {
        kind: "split",
        direction: "horizontal",
        sizes: [50, 50],
        children: [
          { kind: "leaf", paneId: "pane-1" },
          { kind: "leaf", paneId: "pane-2" },
        ],
      },
      activePaneId: "pane-2",
    });
  });

  it("returns split pane layout while preserving legacy pane layout fields", () => {
    expect(resolveTerminalV2SplitPaneLayout({ ...paneLayout, mode: "focus", focusCellId: "pane-1" }, "pane-1", "pane-2", "horizontal")).toEqual({
      mode: "focus",
      focusCellId: "pane-1",
      terminalV2Layout: {
        root: {
          kind: "split",
          direction: "horizontal",
          sizes: [50, 50],
          children: [
            { kind: "leaf", paneId: "pane-1" },
            { kind: "leaf", paneId: "pane-2" },
          ],
        },
        activePaneId: "pane-2",
      },
    });
  });

  it("returns collapsed pane layout when a V2 pane is removed", () => {
    const split = resolveTerminalV2SplitPaneLayout(paneLayout, "pane-1", "pane-2", "horizontal")!;

    expect(resolveTerminalV2RemovePaneLayout(split, "pane-2")).toEqual({
      mode: "grid",
      focusCellId: null,
      terminalV2Layout: {
        root: { kind: "leaf", paneId: "pane-1" },
        activePaneId: "pane-1",
      },
    });
  });
});

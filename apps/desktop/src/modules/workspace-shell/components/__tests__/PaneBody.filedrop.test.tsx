import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PaneBody } from "@/modules/workspace-shell/components/PaneBody";
import type { GridCell, Workspace } from "@/modules/codespace/components/types";

/**
 * The pane's own surface is under test, not what a terminal draws inside it. Every heavy child is
 * stubbed so the assertion is about the drop target's markup and nothing else — mounting xterm,
 * a webview or the PTY runtime here would make a test about five attributes take a second and
 * fail for reasons that have nothing to do with them.
 */
vi.mock("@/modules/codespace/terminal-v2/components/InteractiveTerminalV2", () => ({
  InteractiveTerminalV2: () => <div data-testid="terminal-v2" />,
}));
vi.mock("@/modules/codespace/components/LegacyInteractiveTerminal", () => ({
  LegacyInteractiveTerminal: () => <div data-testid="terminal-legacy" />,
}));
vi.mock("@/modules/codespace/components/WorkbenchCell", () => ({
  WorkbenchCell: () => <div data-testid="workbench-cell" />,
}));
vi.mock("@/modules/codespace/components/ChatCell", () => ({
  ChatCell: () => <div data-testid="chat-cell" />,
}));
vi.mock("@/modules/codespace/terminal-v2/runtime/TerminalV2RuntimeProvider", () => ({
  useOptionalTerminalV2Runtime: () => null,
}));
vi.mock("@/modules/codespace/hooks/useTerminalPreferences", () => ({
  useTerminalPreferences: () => ({ terminalFontSize: 13 }),
}));
// A new terminal pane is veiled until its first output, and the veil paints the terminal background.
vi.mock("@/modules/codespace/services/codespace-terminal-render-theme", () => ({
  resolveCodeSpaceTerminalRenderTheme: () => ({ background: "#111" }),
}));
vi.mock("@/contexts/ThemeContext", () => ({
  useTheme: () => ({ theme: {}, themeId: "test" }),
}));

const noop = () => undefined;

function workspace(patch: Partial<Workspace> = {}): Workspace {
  return { id: "ws", label: "ws", color: "#000", cwd: "/repo", rows: 1, cols: 1, cells: [], ...patch };
}

function renderPane(cell: GridCell, ws: Workspace = workspace()) {
  return render(
    <PaneBody
      workspace={ws}
      cell={cell}
      focused
      active
      attached
      maximized={false}
      onRuntimeSessionIdChange={noop}
      onRuntimeStatusChange={noop}
      onBrowserUrlChange={noop}
      onUpdateWorkbenchCell={noop}
    />,
  );
}

describe("PaneBody file-drop target", () => {
  it("marks a terminal pane so a native file drop can find it", () => {
    const { container } = renderPane({
      id: "t1",
      type: "terminal",
      cwd: "/repo/api",
      runtimeStatus: "live",
    });

    const target = container.querySelector("[data-terminal-file-drop-target='true']");
    expect(target).not.toBeNull();
    expect((target as HTMLElement).dataset).toMatchObject({
      terminalFileDropCellId: "t1",
      terminalFileDropCwd: "/repo/api",
      terminalFileDropStatus: "live",
      terminalFileDropLocation: "local",
    });
  });

  /**
   * Only a terminal can be handed a file path. A chat or browser pane that carried the marker
   * would swallow the drop into a pane with no PTY behind it, and the file would vanish with no
   * error — worse than the drop simply doing nothing.
   */
  it.each([
    ["chat", { id: "c1", type: "chat", cwd: "/repo", sessionId: "s1" } as GridCell],
    ["browser", { id: "b1", type: "browser", cwd: "/repo", url: "https://x.test" } as GridCell],
    ["workbench", { id: "w1", type: "workbench", cwd: "/repo", rootDir: "/repo", tabs: [], activeTabId: null } as GridCell],
  ])("leaves a %s pane unmarked", (_label, cell) => {
    const { container } = renderPane(cell);

    expect(container.querySelector("[data-terminal-file-drop-target]")).toBeNull();
  });

  /**
   * A remote workspace's pane has to say so on the element itself: the drop handler reads the
   * location from the dataset, not from any React state, so this attribute is the only thing
   * standing between a remote shell and a local path it cannot open.
   */
  it("marks a remote workspace's terminal as an upload target", () => {
    const { container } = renderPane(
      { id: "t1", type: "terminal", cwd: "/srv/app" },
      workspace({ location: { kind: "ssh", host: "build.internal", remoteCwd: "/srv/app" } }),
    );

    const target = container.querySelector("[data-terminal-file-drop-target='true']") as HTMLElement;
    expect(target.dataset.terminalFileDropLocation).toBe("ssh");
    // No runtime status on the cell yet: the handler must still see a value it understands.
    expect(target.dataset.terminalFileDropStatus).toBe("idle");
  });
});

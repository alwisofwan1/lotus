// RED — tests for useCanvasTerminalNode, written before implementation.
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";

interface MockSearchAPI {
  findNext: (q: string) => boolean;
  findPrevious: (q: string) => boolean;
  clearSearch: () => void;
}

// Capture every option object passed to useLegacyTerminalRuntime so tests can trigger callbacks.
const capturedOptions: {
  active?: boolean;
  workspaceId?: string;
  paneId?: string;
  fontSize?: number;
  onRuntimeStatusChange?: (s: TerminalRuntimeStatus) => void;
  onCurrentDirectoryChange?: (cwd: string) => void;
  terminalTheme?: unknown;
  allowTransparency?: boolean;
  onSearchReady?: (api: MockSearchAPI) => void;
}[] = [];

const mockContainerRef    = { current: null };
const mockHelperTextareaRef = { current: null };

vi.mock("@/modules/codespace/hooks/useLegacyTerminalRuntime", () => ({
  useLegacyTerminalRuntime: vi.fn((opts: (typeof capturedOptions)[0]) => {
    capturedOptions.push(opts);
    return { containerRef: mockContainerRef, helperTextareaRef: mockHelperTextareaRef };
  }),
  useTerminalRuntime: vi.fn((opts: (typeof capturedOptions)[0]) => {
    capturedOptions.push(opts);
    return { containerRef: mockContainerRef, helperTextareaRef: mockHelperTextareaRef };
  }),
}));

import { useCanvasTerminalNode } from "../useCanvasTerminalNode";
import { CANVAS_TERMINAL_TYPOGRAPHY } from "@/modules/codecanvas/services/canvas-terminal-typography";

function lastCapture() {
  return capturedOptions[capturedOptions.length - 1];
}

describe("useCanvasTerminalNode", () => {
  beforeEach(() => { capturedOptions.length = 0; });

  describe("forwarding to useLegacyTerminalRuntime", () => {
    it("defaults active:true — a canvas terminal renders live unless told otherwise", () => {
      renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      expect(lastCapture().active).toBe(true);
    });

    it("forwards active:false so the runtime pauses rendering at the zoomed-out glyph tier", () => {
      renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app", active: false }));
      expect(lastCapture().active).toBe(false);
    });

    it("uses the canonical canvas workspaceId", () => {
      renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      expect(lastCapture().workspaceId).toBe("canvas:default");
    });

    it("uses the node id as paneId so the session-registry can key the session", () => {
      renderHook(() => useCanvasTerminalNode({ id: "node-uuid-42", cwd: "/app" }));
      expect(lastCapture().paneId).toBe("node-uuid-42");
    });

    it("accepts project-scoped runtime ids for multi-project canvases", () => {
      renderHook(() => useCanvasTerminalNode({
        id: "node-uuid-42",
        cwd: "/app",
        runtimeScope: "canvas:cp_123",
        runtimePaneId: "canvas:cp_123:node-uuid-42",
      }));
      expect(lastCapture().workspaceId).toBe("canvas:cp_123");
      expect(lastCapture().paneId).toBe("canvas:cp_123:node-uuid-42");
    });

    it("sizes the terminal from the shared canvas type scale, not a local constant", () => {
      // One scale for both canvas terminal families — the Live Agent Terminal reads the same
      // module, so the two can no longer drift apart.
      renderHook(() => useCanvasTerminalNode({ id: "t1", cwd: "/tmp" }));
      expect(lastCapture().fontSize).toBe(CANVAS_TERMINAL_TYPOGRAPHY.fontSize);
    });

    it("can opt the xterm runtime into a transparent themed surface", () => {
      const terminalTheme = {
        background: "rgba(0, 0, 0, 0)",
        foreground: "rgb(232, 238, 246)",
        cursor: "rgb(125, 249, 255)",
        cursorAccent: "rgb(6, 8, 18)",
        selectionBackground: "rgba(125, 249, 255, 0.28)",
        black: "rgb(20, 23, 34)",
        brightBlack: "rgb(69, 76, 94)",
        red: "rgb(248, 113, 113)",
        brightRed: "rgb(252, 165, 165)",
        green: "rgb(52, 211, 153)",
        brightGreen: "rgb(110, 231, 183)",
        yellow: "rgb(251, 191, 36)",
        brightYellow: "rgb(252, 211, 77)",
        blue: "rgb(96, 165, 250)",
        brightBlue: "rgb(147, 197, 253)",
        magenta: "rgb(192, 132, 252)",
        brightMagenta: "rgb(216, 180, 254)",
        cyan: "rgb(34, 211, 238)",
        brightCyan: "rgb(103, 232, 249)",
        white: "rgb(232, 238, 246)",
        brightWhite: "rgb(248, 250, 252)",
      };
      renderHook(() => useCanvasTerminalNode({
        id: "n1",
        cwd: "/app",
        terminalTheme,
        allowTransparency: true,
      }));

      expect(lastCapture().terminalTheme).toBe(terminalTheme);
      expect(lastCapture().allowTransparency).toBe(true);
    });
  });

  describe("refs", () => {
    it("exposes the containerRef returned by useLegacyTerminalRuntime", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      expect(result.current.containerRef).toBe(mockContainerRef);
    });

    it("exposes the helperTextareaRef returned by useLegacyTerminalRuntime", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      expect(result.current.helperTextareaRef).toBe(mockHelperTextareaRef);
    });
  });

  describe("runtimeStatus", () => {
    it("starts at 'idle'", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      expect(result.current.runtimeStatus).toBe("idle");
    });

    it("reflects status updates from the runtime", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      act(() => lastCapture().onRuntimeStatusChange?.("live"));
      expect(result.current.runtimeStatus).toBe("live");
    });

    it("tracks multiple transitions", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      act(() => lastCapture().onRuntimeStatusChange?.("starting"));
      expect(result.current.runtimeStatus).toBe("starting");
      act(() => lastCapture().onRuntimeStatusChange?.("live"));
      expect(result.current.runtimeStatus).toBe("live");
      act(() => lastCapture().onRuntimeStatusChange?.("exited"));
      expect(result.current.runtimeStatus).toBe("exited");
    });
  });

  describe("currentCwd", () => {
    it("starts at the initial cwd", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/projects/app" }));
      expect(result.current.currentCwd).toBe("/projects/app");
    });

    it("updates when the runtime fires onCurrentDirectoryChange", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      act(() => lastCapture().onCurrentDirectoryChange?.("/app/src"));
      expect(result.current.currentCwd).toBe("/app/src");
    });

    it("propagates changes to the caller's onCwdChange", () => {
      const onCwdChange = vi.fn();
      renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app", onCwdChange }));
      act(() => lastCapture().onCurrentDirectoryChange?.("/app/src"));
      expect(onCwdChange).toHaveBeenCalledOnce();
      expect(onCwdChange).toHaveBeenCalledWith("/app/src");
    });

    it("does not call onCwdChange when it is not provided", () => {
      // Should not throw
      renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      expect(() => act(() => lastCapture().onCurrentDirectoryChange?.("/app/src"))).not.toThrow();
    });
  });

  describe("searchAPI", () => {
    it("starts as null — search is unavailable until the runtime is ready", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      expect(result.current.searchAPI).toBeNull();
    });

    it("becomes available when the runtime fires onSearchReady", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      const mockAPI: MockSearchAPI = {
        findNext:    vi.fn(() => true),
        findPrevious: vi.fn(() => false),
        clearSearch:  vi.fn(),
      };
      act(() => lastCapture().onSearchReady?.(mockAPI));
      expect(result.current.searchAPI).toBe(mockAPI);
    });
  });

  describe("action bar — panels", () => {
    it("starts with no panel open", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      expect(result.current.activePanel).toBeNull();
    });

    it("toggleWT opens the worktree panel", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      act(() => result.current.toggleWT());
      expect(result.current.activePanel).toBe("wt");
    });

    it("toggleSK opens the skill panel", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      act(() => result.current.toggleSK());
      expect(result.current.activePanel).toBe("sk");
    });

    it("toggling the same panel twice closes it", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      act(() => result.current.toggleSK());
      act(() => result.current.toggleSK());
      expect(result.current.activePanel).toBeNull();
    });

    it("only one panel is open at a time — opening WT closes SK", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      act(() => result.current.toggleSK());
      act(() => result.current.toggleWT());
      expect(result.current.activePanel).toBe("wt");
    });

    it("closePanel closes whatever is open", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      act(() => result.current.toggleWT());
      act(() => result.current.closePanel());
      expect(result.current.activePanel).toBeNull();
    });
  });

  describe("action bar — worktree intent", () => {
    it("assignWorktree forwards branch AND path and closes the panel", () => {
      const onWorktreeChange = vi.fn();
      const { result } = renderHook(() =>
        useCanvasTerminalNode({ id: "n1", cwd: "/app", onWorktreeChange }),
      );
      act(() => result.current.toggleWT());
      act(() => result.current.assignWorktree("feature/x", "/app-wt/feature-x"));
      expect(onWorktreeChange).toHaveBeenCalledWith("feature/x", "/app-wt/feature-x");
      expect(result.current.activePanel).toBeNull();
    });

    it("unassignWorktree forwards (null, null) and closes the panel", () => {
      const onWorktreeChange = vi.fn();
      const { result } = renderHook(() =>
        useCanvasTerminalNode({ id: "n1", cwd: "/app", onWorktreeChange }),
      );
      act(() => result.current.toggleWT());
      act(() => result.current.unassignWorktree());
      expect(onWorktreeChange).toHaveBeenCalledWith(null, null);
      expect(result.current.activePanel).toBeNull();
    });

    it("assignWorktree does not throw when onWorktreeChange is absent", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      expect(() => act(() => result.current.assignWorktree("feature/x", "/app-wt/feature-x"))).not.toThrow();
      expect(result.current.activePanel).toBeNull();
    });
  });

  describe("action bar — search visibility (absorbs the searchAPI guard)", () => {
    it("starts hidden", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      expect(result.current.searchVisible).toBe(false);
    });

    it("openSearch is a no-op while the runtime search API is unavailable", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      act(() => result.current.openSearch());
      expect(result.current.searchVisible).toBe(false);
    });

    it("openSearch shows the bar once the runtime fires onSearchReady", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      act(() => lastCapture().onSearchReady?.({ findNext: vi.fn(), findPrevious: vi.fn(), clearSearch: vi.fn() }));
      act(() => result.current.openSearch());
      expect(result.current.searchVisible).toBe(true);
    });

    it("closeSearch hides the bar", () => {
      const { result } = renderHook(() => useCanvasTerminalNode({ id: "n1", cwd: "/app" }));
      act(() => lastCapture().onSearchReady?.({ findNext: vi.fn(), findPrevious: vi.fn(), clearSearch: vi.fn() }));
      act(() => result.current.openSearch());
      act(() => result.current.closeSearch());
      expect(result.current.searchVisible).toBe(false);
    });
  });
});

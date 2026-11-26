import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";
import type { CanvasSearchAPI, CanvasActivePanel } from "@/modules/codecanvas/hooks/useCanvasTerminalNode";

// ── Mock @xyflow/react (CanvasNodeFrame uses Handle + NodeResizer) ───────────
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    Handle: () => null,
    NodeResizer: () => <div data-testid="node-resizer" />,
  };
});

// ── Mock useCanvasTerminalNode — the component is now pure wiring, so the hook
//    return is the control surface for these tests. Panel/search *logic* lives
//    in useCanvasTerminalNode.test.ts. ──────────────────────────────────────
const mockContainerRef      = { current: null };
const mockHelperTextareaRef = { current: null };
let mockRuntimeStatus: TerminalRuntimeStatus = "idle";
let mockSearchAPI: CanvasSearchAPI | null = null;
let mockActivePanel: CanvasActivePanel = null;
let mockSearchVisible = false;
let mockLink: import("@/modules/workspace-shell/components/SshLinkStrip").LinkStrip = { kind: "none" };
const mockToggleWT = vi.fn();
const mockToggleSK = vi.fn();
const mockClosePanel = vi.fn();
const mockAssignWorktree = vi.fn();
const mockUnassignWorktree = vi.fn();
const mockOpenSearch = vi.fn();
const mockCloseSearch = vi.fn();

vi.mock("@/modules/codecanvas/hooks/useCanvasTerminalNode", () => ({
  useCanvasTerminalNode: vi.fn(({ cwd }: { cwd: string }) => ({
    containerRef:      mockContainerRef,
    helperTextareaRef: mockHelperTextareaRef,
    runtimeStatus:     mockRuntimeStatus,
    activity:          "idle",
    currentCwd:        cwd,
    searchAPI:         mockSearchAPI,
    activePanel:       mockActivePanel,
    toggleWT:          mockToggleWT,
    closePanel:        mockClosePanel,
    assignWorktree:    mockAssignWorktree,
    unassignWorktree:  mockUnassignWorktree,
    searchVisible:     mockSearchVisible,
    openSearch:        mockOpenSearch,
    closeSearch:       mockCloseSearch,
    link:              mockLink,
    sessionId:         "pty-1",
  })),
}));

// ── Mock useCanvasLodTier — drive the zoom tier deterministically ────────────
let mockLodTier: "full" | "glyph" | "overview" = "full";
vi.mock("@/modules/codecanvas/hooks/useCanvasLodTier", () => ({
  useCanvasLodTier: () => mockLodTier,
}));

// ── Mock CanvasTerminalHeader (renders a minimal stub) ───────────────────────
vi.mock("../nodes/CanvasTerminalHeader", () => ({
  CanvasTerminalHeader: ({ terminalNumber, label, runtimeStatus, worktreeActive, skillsActive, onKill, onToggleWT, onToggleSK, onToggleBrowser, onRename }: {
    terminalNumber: number; label?: string; runtimeStatus: string; worktreeActive: boolean; skillsActive: boolean;
    onKill: () => void; onToggleWT: () => void; onToggleSK: () => void; onToggleBrowser: () => void;
    onRename?: (label: string) => void;
  }) => (
    <div data-testid="canvas-terminal-header">
      <span>{label || `Terminal ${terminalNumber}`}</span>
      {onRename ? <button aria-label="Rename terminal" onClick={() => onRename("Test runner")}>Rename</button> : null}
      <span className={`cth-status--${runtimeStatus}`}>{runtimeStatus}</span>
      <button aria-label="Worktree" data-active={worktreeActive ? "true" : "false"} onClick={onToggleWT}>WT</button>
      <button aria-label="Skill" data-active={skillsActive ? "true" : "false"} onClick={onToggleSK}>SK</button>
      <button aria-label="Browser" onClick={onToggleBrowser}>BR</button>
      <button aria-label="Kill terminal" onClick={onKill}>Kill</button>
    </div>
  ),
}));

// ── Mock panels ──────────────────────────────────────────────────────────────
vi.mock("../panels/CanvasWorktreePanel", () => ({
  CanvasWorktreePanel: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="canvas-worktree-panel"><button onClick={onClose}>Close WT</button></div>
  ),
}));

// Active Artisan theme mode drives the Adaptive Ink palette. Default dark keeps
// every existing test on the dark palette; individual tests flip it to "light".
// A REAL builtin theme, not a `{ mode }` stub: the node now resolves its opaque floor from the
// whole theme (paper/material/surface/glass), so a partial object throws inside the resolver.
let mockThemeMode: "dark" | "light" = "dark";
vi.mock("@/modules/codecanvas/hooks/useCanvasTheme", async () => {
  const { defaultCanvasTheme } = await import("@/modules/codecanvas/services/theme/builtin-themes");
  return { useCanvasTheme: () => ({ theme: { ...defaultCanvasTheme(), mode: mockThemeMode } }) };
});

import { useCanvasTerminalNode } from "@/modules/codecanvas/hooks/useCanvasTerminalNode";
import { resolveCanvasTerminalTheme } from "@/modules/codecanvas/services/theme/canvas-terminal-theme";
import { resolveTerminalFloor } from "@/modules/codecanvas/services/theme/terminal-floor";
import { defaultCanvasTheme } from "@/modules/codecanvas/services/theme/builtin-themes";

/** The floor the node should resolve for a given mode — same inputs the component sees. */
function expectedFloor(mode: "dark" | "light"): string {
  return resolveTerminalFloor({ ...defaultCanvasTheme(), mode }).background;
}
import { TerminalNode } from "../nodes/TerminalNode";
import type { TerminalNodeData } from "../nodes/TerminalNode";

function makeProps(overrides?: Partial<TerminalNodeData>): Parameters<typeof TerminalNode>[0] {
  return {
    id: "term-1",
    data: {
      cwd: "/projects/app",
      terminalNumber: 1,
      assignedWorktree: null,
      onClose: vi.fn(),
      ...overrides,
    },
    selected: false,
  } as unknown as Parameters<typeof TerminalNode>[0];
}

describe("TerminalNode", () => {
  beforeEach(() => {
    localStorage.clear();
    mockRuntimeStatus = "idle";
    mockLink = { kind: "none" };
    mockSearchAPI = null;
    mockActivePanel = null;
    mockSearchVisible = false;
    mockLodTier = "full";
    mockThemeMode = "dark";
    vi.clearAllMocks();
  });

  describe("adaptive ink surface", () => {
    function lastRuntimeTheme() {
      const opts = vi.mocked(useCanvasTerminalNode).mock.calls.at(-1)?.[0] as {
        terminalTheme: { background: string; foreground: string };
        allowTransparency: boolean;
      };
      return opts;
    }

    // The Terminal Node runs the SAME opaque floor as the live agent (see LiveAgentNode and
    // plans/canvas-terminal-opaque-floor). It used to run transparent over a CSS ink-floor, which
    // is what made the two node families render as different materials side by side — a blurred
    // photo next to an opaque ground — and forced per-cell alpha compositing on this node.
    it("paints its own opaque floor rather than running transparent over the CSS surface", () => {
      render(<TerminalNode {...makeProps()} />);
      const opts = lastRuntimeTheme();
      expect(opts.allowTransparency).toBe(false);
      expect(opts.terminalTheme.background).toBe(expectedFloor("dark"));
    });

    it("derives the xterm palette from the active theme mode (dark)", () => {
      render(<TerminalNode {...makeProps()} />);
      expect(lastRuntimeTheme().terminalTheme).toEqual(
        resolveCanvasTerminalTheme({ mode: "dark", background: expectedFloor("dark") }),
      );
    });

    it("flips to the dark-ink palette when the active theme is light", () => {
      mockThemeMode = "light";
      render(<TerminalNode {...makeProps()} />);
      expect(lastRuntimeTheme().terminalTheme).toEqual(
        resolveCanvasTerminalTheme({ mode: "light", background: expectedFloor("light") }),
      );
    });

    it("resolves the same floor the live agent does, so neighbouring nodes cannot drift", () => {
      // One resolver, one input: whatever the agent node paints, this node paints. Asserted on the
      // value rather than the call so a future refactor of either component still has to match.
      render(<TerminalNode {...makeProps()} />);
      expect(lastRuntimeTheme().terminalTheme.background).toBe(
        resolveTerminalFloor({ ...defaultCanvasTheme(), mode: "dark" }).background,
      );
    });
  });

  describe("structure", () => {
    it("renders the terminal container", () => {
      render(<TerminalNode {...makeProps()} />);
      expect(screen.getByTestId("canvas-terminal-body")).toBeInTheDocument();
    });

    it("exposes its input surface as a command-delivery target", () => {
      render(<TerminalNode {...makeProps()} />);
      expect(screen.getByTestId("canvas-terminal-body")).toHaveAttribute(
        "data-canvas-command-delivery-target",
        "term-1",
      );
    });

    it("wraps xterm in the styled canvas host so terminal chrome owns clipping and scrollbar skin", () => {
      render(<TerminalNode {...makeProps()} />);
      expect(document.querySelector(".canvas-terminal-host")).toBeInTheDocument();
    });

    it("at the glyph tier covers the terminal with a glyph WITHOUT unmounting the xterm host", () => {
      mockLodTier = "glyph";
      render(<TerminalNode {...makeProps()} />);
      // Host stays mounted — the session is never orphaned by a zoom crossing.
      expect(document.querySelector(".canvas-terminal-host")).toBeInTheDocument();
      expect(screen.getByTestId("canvas-terminal-glyph-cover")).toBeInTheDocument();
      expect(vi.mocked(useCanvasTerminalNode).mock.calls.at(-1)?.[0]).toMatchObject({ active: false });
    });

    it("at the overview tier pauses terminal rendering and keeps the spatial glyph cover", () => {
      mockLodTier = "overview";
      render(<TerminalNode {...makeProps()} />);
      expect(document.querySelector(".canvas-terminal-host")).toBeInTheDocument();
      expect(screen.getByTestId("canvas-terminal-glyph-cover")).toBeInTheDocument();
      expect(vi.mocked(useCanvasTerminalNode).mock.calls.at(-1)?.[0]).toMatchObject({ active: false });
    });

    it("shows no glyph cover at the full tier", () => {
      render(<TerminalNode {...makeProps()} />);
      expect(screen.queryByTestId("canvas-terminal-glyph-cover")).not.toBeInTheDocument();
      expect(vi.mocked(useCanvasTerminalNode).mock.calls.at(-1)?.[0]).toMatchObject({ active: true });
    });

    it("mounts NO wallpaper backdrop", () => {
      // The per-node blurred wallpaper copy is gone. xterm now paints an opaque floor over the
      // entire grid, so a canvas at z-index 0 beneath it could never be seen — it was a full
      // wallpaper redraw plus a blur(11px) filter per terminal node, paying for invisible pixels
      // on the exact surface being optimised.
      render(<TerminalNode {...makeProps()} />);

      expect(document.querySelector(".canvas-terminal-backdrop-canvas")).not.toBeInTheDocument();
      expect(document.querySelector(".canvas-terminal-host")).toBeInTheDocument();
    });

    it("renders inside a frame with the NodeResizer for drag-resize", () => {
      render(<TerminalNode {...makeProps()} />);
      expect(screen.getByTestId("node-resizer")).toBeInTheDocument();
    });
  });

  describe("header", () => {
    it("renders the CanvasTerminalHeader with terminal number", () => {
      render(<TerminalNode {...makeProps({ terminalNumber: 3 })} />);
      expect(screen.getByTestId("canvas-terminal-header")).toBeInTheDocument();
      expect(screen.getByText("Terminal 3")).toBeInTheDocument();
    });

    it("passes the runtime status to the header", () => {
      mockRuntimeStatus = "live";
      render(<TerminalNode {...makeProps()} />);
      expect(document.querySelector(".cth-status--live")).toBeInTheDocument();
    });

    it("routes terminal rename through the node command seam", () => {
      const dispatchCommand = vi.fn();
      render(<TerminalNode {...makeProps({ label: "API server", dispatchCommand })} />);

      fireEvent.click(screen.getByRole("button", { name: "Rename terminal" }));

      expect(dispatchCommand).toHaveBeenCalledWith({
        kind: "patch-terminal",
        nodeId: "term-1",
        patch: { label: "Test runner" },
      });
    });
  });

  describe("close (Kill)", () => {
    it("calls onClose with the node id when Kill is clicked", () => {
      const onClose = vi.fn();
      render(<TerminalNode {...makeProps({ onClose })} />);
      fireEvent.click(screen.getByRole("button", { name: "Kill terminal" }));
      expect(onClose).toHaveBeenCalledOnce();
      expect(onClose).toHaveBeenCalledWith("term-1");
    });

    it("emits terminal commands through the node command seam", () => {
      const dispatchCommand = vi.fn();
      render(<TerminalNode {...makeProps({ dispatchCommand, onClose: undefined, onCwdChange: undefined, onWorktreeChange: undefined, onAddSkillsNode: undefined, onToggleBrowser: undefined })} />);

      const runtimeOptions = vi.mocked(useCanvasTerminalNode).mock.calls.at(-1)?.[0] as {
        onCwdChange: (cwd: string) => void;
        onWorktreeChange: (branch: string | null, path: string | null) => void;
      };
      runtimeOptions.onCwdChange("/repo/new");
      runtimeOptions.onWorktreeChange("feature/demo", "/repo/worktrees/demo");
      fireEvent.click(screen.getByRole("button", { name: "Skill" }));
      fireEvent.click(screen.getByRole("button", { name: "Browser" }));
      fireEvent.click(screen.getByRole("button", { name: "Kill terminal" }));

      expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-terminal", nodeId: "term-1", patch: { cwd: "/repo/new" } });
      expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-terminal", nodeId: "term-1", patch: { assignedWorktree: "feature/demo", assignedWorktreePath: "/repo/worktrees/demo" } });
      expect(dispatchCommand).toHaveBeenCalledWith({ kind: "terminal-add-skills", terminalId: "term-1", cwd: "/projects/app" });
      expect(dispatchCommand).toHaveBeenCalledWith({ kind: "toggle-browser", terminalId: "term-1" });
      expect(dispatchCommand).toHaveBeenCalledWith({ kind: "close-node", nodeId: "term-1" });
    });

    it("shows a recovery action when the runtime failed", () => {
      mockRuntimeStatus = "failed";
      const dispatchCommand = vi.fn();
      render(<TerminalNode {...makeProps({ dispatchCommand })} />);

      expect(screen.getByText("Terminal needs recovery")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Restart terminal" }));

      expect(dispatchCommand).toHaveBeenCalledWith({ kind: "recover-terminal", nodeId: "term-1" });
    });
  });

  describe("link to a remote machine", () => {
    it("shows the reconnect strip and holds keys while the link is down", () => {
      mockLink = { kind: "needs-sign-in" };
      render(<TerminalNode {...makeProps()} />);

      expect(screen.getByText(/Sign-in Cloudflare kedaluwarsa/)).toBeInTheDocument();
      const body = screen.getByTestId("canvas-terminal-body");
      expect(body).toHaveAttribute("data-link-held", "true");
      const key = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
      body.dispatchEvent(key);
      expect(key.defaultPrevented).toBe(true);
    });

    it("holds nothing while the link is up", () => {
      render(<TerminalNode {...makeProps()} />);
      expect(screen.getByTestId("canvas-terminal-body")).not.toHaveAttribute("data-link-held");
    });
  });

  describe("action bar wiring", () => {
    it("clicking the WT button delegates to the hook's toggleWT", () => {
      render(<TerminalNode {...makeProps()} />);
      fireEvent.click(screen.getByRole("button", { name: "Worktree" }));
      expect(mockToggleWT).toHaveBeenCalledOnce();
    });

    it("clicking the SK button spawns or focuses a Skills node without closing it as a local tab", () => {
      const onAddSkillsNode = vi.fn();
      render(<TerminalNode {...makeProps({ onAddSkillsNode })} />);
      fireEvent.click(screen.getByRole("button", { name: "Skill" }));
      expect(mockToggleSK).not.toHaveBeenCalled();
      expect(onAddSkillsNode).toHaveBeenCalledWith("term-1", "/projects/app");
    });

    it("keeps the SK header action active when a Skills node exists, even while WT is active", () => {
      mockActivePanel = "wt";
      render(<TerminalNode {...makeProps({ hasSkillsNode: true })} />);
      expect(screen.getByRole("button", { name: "Worktree" })).toHaveAttribute("data-active", "true");
      expect(screen.getByRole("button", { name: "Skill" })).toHaveAttribute("data-active", "true");
    });

    it("switching back to SK closes the local Worktree panel but keeps/focuses the Skills node", () => {
      mockActivePanel = "wt";
      const onAddSkillsNode = vi.fn();
      render(<TerminalNode {...makeProps({ hasSkillsNode: true, onAddSkillsNode })} />);
      fireEvent.click(screen.getByRole("button", { name: "Skill" }));
      expect(mockClosePanel).toHaveBeenCalledOnce();
      expect(onAddSkillsNode).toHaveBeenCalledWith("term-1", "/projects/app");
    });

    it("renders the worktree panel when the hook reports activePanel 'wt'", () => {
      mockActivePanel = "wt";
      render(<TerminalNode {...makeProps()} />);
      expect(screen.getByTestId("canvas-worktree-panel")).toBeInTheDocument();
    });

    it("renders no worktree panel when the hook reports activePanel null", () => {
      mockActivePanel = null;
      render(<TerminalNode {...makeProps()} />);
      expect(screen.queryByTestId("canvas-worktree-panel")).not.toBeInTheDocument();
    });
  });

  describe("search wiring (Cmd+F)", () => {
    it("does not render the search bar when the hook reports searchVisible false", () => {
      mockSearchVisible = false;
      render(<TerminalNode {...makeProps()} />);
      expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
    });

    it("renders the search bar when searchVisible and searchAPI are present", () => {
      mockSearchVisible = true;
      mockSearchAPI = { findNext: vi.fn(), findPrevious: vi.fn(), clearSearch: vi.fn() };
      render(<TerminalNode {...makeProps()} />);
      expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument();
    });

    it("Cmd+F on the body delegates to the hook's openSearch", () => {
      render(<TerminalNode {...makeProps()} />);
      fireEvent.keyDown(screen.getByTestId("canvas-terminal-body"), { key: "f", metaKey: true });
      expect(mockOpenSearch).toHaveBeenCalledOnce();
    });

    it("Ctrl+F on the body delegates to the hook's openSearch", () => {
      render(<TerminalNode {...makeProps()} />);
      fireEvent.keyDown(screen.getByTestId("canvas-terminal-body"), { key: "f", ctrlKey: true });
      expect(mockOpenSearch).toHaveBeenCalledOnce();
    });
  });

  describe("ReactFlow pointer isolation (ghost-selection regression)", () => {
    it("has nodrag class on the terminal body to prevent ReactFlow node-drag from this area", () => {
      render(<TerminalNode {...makeProps()} />);
      expect(screen.getByTestId("canvas-terminal-body")).toHaveClass("nodrag");
    });

    it("has nopan class on the terminal body to prevent ReactFlow canvas-pan from this area", () => {
      render(<TerminalNode {...makeProps()} />);
      expect(screen.getByTestId("canvas-terminal-body")).toHaveClass("nopan");
    });

    it("has nowheel class on the terminal body to prevent ReactFlow zoom when scrolling in terminal", () => {
      render(<TerminalNode {...makeProps()} />);
      expect(screen.getByTestId("canvas-terminal-body")).toHaveClass("nowheel");
    });

    it("stops pointer propagation on the terminal body to prevent ReactFlow setPointerCapture breaking xterm's mouse event sequence", () => {
      render(<TerminalNode {...makeProps()} />);
      const body = screen.getByTestId("canvas-terminal-body");
      const event = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
      const stopSpy = vi.spyOn(event, "stopPropagation");
      body.dispatchEvent(event);
      expect(stopSpy).toHaveBeenCalled();
    });
  });
});

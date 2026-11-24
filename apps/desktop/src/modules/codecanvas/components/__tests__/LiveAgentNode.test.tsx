import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { Terminal } from "@xterm/xterm";
import { noteAgentAsk } from "@/modules/codecanvas/services/agent-ask";

const mockUsePtySession = vi.fn<(options: unknown) => unknown>(() => ({
  sessionId: null,
  status: "connecting",
  mode: null,
  write: vi.fn(),
  resize: vi.fn(),
}));

vi.mock("@/hooks/usePtySession", () => ({
  usePtySession: (options: unknown) => mockUsePtySession(options),
}));

vi.mock("@dnd-kit/core", () => ({
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: vi.fn().mockImplementation(function (this: void) {
    return {
      unicode: { activeVersion: "11" },
      // Live-mutated by the theme effect, so it has to exist on the mock.
      options: {} as Record<string, unknown>,
      loadAddon: vi.fn(),
      open: vi.fn(),
      focus: vi.fn(),
      write: vi.fn(),
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onCursorMove: vi.fn(() => ({ dispose: vi.fn() })),
      attachCustomKeyEventHandler: vi.fn(),
      buffer: { active: { cursorY: 0 } },
      cols: 80,
      rows: 24,
      dispose: vi.fn(),
    };
  }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(function (this: void) {
    return { fit: vi.fn() };
  }),
}));
vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: vi.fn().mockImplementation(function (this: void) {
    return {};
  }),
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(function (this: void) {
    return {};
  }),
}));

vi.mock("@/modules/codespace/services/terminal-keybindings", () => ({
  handleTerminalCustomKeyEvent: vi.fn(() => false),
  KITTY_SHIFT_ENTER_SEQUENCE: "\u001b[13;2u",
  META_ENTER_SEQUENCE: "\u001b\r",
}));

// Mocked so the wiring can be asserted in isolation: `pane-ask-buffer` and `agent-ask` each have
// their own unit suites, and what is unproven here is whether typed input actually REACHES them.
vi.mock("@/modules/codecanvas/services/agent-ask", () => ({
  noteAgentAsk: vi.fn(),
  publishHeadline: vi.fn(),
}));

vi.mock("@/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri-api")>()),
  listClaudeSessions: vi.fn(async () => []),
  // The node's account chip reads both on mount.
  listAccounts: vi.fn(async () => []),
  getUsageSnapshot: vi.fn(async () => []),
}));

// Only the forcing helper is stubbed — the type scale and the font stack stay real so the
// typography assertions below compare against the actual shared contract.
const mockForceFontFamilyRemeasure = vi.fn();
vi.mock("@/modules/codecanvas/services/canvas-terminal-typography", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/codecanvas/services/canvas-terminal-typography")>()),
  forceFontFamilyRemeasure: (...args: unknown[]) => mockForceFontFamilyRemeasure(...args),
}));

vi.mock("@/lib/runner-registry-cache", () => ({
  runnerRegistryCache: {
    getRunner: vi.fn(async () => null),
    listRunners: vi.fn(async () => ({ runners: [] })),
  },
}));

vi.mock("../nodes/CanvasNodeFrame", () => ({
  CanvasNodeFrame: ({ header, children }: { header?: React.ReactNode; children: React.ReactNode }) => (
    <div>
      {header}
      {children}
    </div>
  ),
}));
vi.mock("../nodes/CanvasPtyViewport", () => ({
  CanvasPtyViewport: ({ containerRef }: { containerRef?: React.Ref<HTMLDivElement> }) => (
    <div ref={containerRef} data-testid="pty-viewport" />
  ),
}));
const { headerProps } = vi.hoisted(() => ({ headerProps: [] as Record<string, unknown>[] }));
vi.mock("../nodes/AgentPersonaHeader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../nodes/AgentPersonaHeader")>();
  return {
    ...actual,
    AgentPersonaHeader: (props: React.ComponentProps<typeof actual.AgentPersonaHeader>) => {
      headerProps.push(props as unknown as Record<string, unknown>);
      return <actual.AgentPersonaHeader {...props} />;
    },
  };
});

vi.mock("../../hooks/useCanvasLodTier", () => ({ useCanvasLodTier: () => "full" }));
vi.mock("../../hooks/useCanvasBehaviorSettings", () => ({
  useCanvasBehaviorSettings: () => ({ allowAgentCanvasControl: false }),
}));
vi.mock("../../services/canvas-drop-target-store", () => ({ useCanvasDropTarget: () => false }));
vi.mock("../../hooks/useAgentReplyRegistration", () => ({ useAgentReplyRegistration: vi.fn() }));

const mockActivateWebglRenderer = vi.fn<(...args: unknown[]) => Promise<{ dispose: () => void } | null>>(
  async () => ({ dispose: vi.fn() }),
);
vi.mock("@/modules/codespace/services/terminal-addons", () => ({
  activateWebglRenderer: (...args: unknown[]) => mockActivateWebglRenderer(...args),
}));

import { LiveAgentNode } from "../nodes/LiveAgentNode";
import type { CanvasAgentNodeData } from "../../types/canvas";
import { runnerRegistryCache } from "@/lib/runner-registry-cache";
import { getUsageSnapshot, listAccounts } from "@/lib/tauri-api";
import { agentStatusRegistry } from "../../services/agent-status-registry";
import { paneTurnRegistry } from "../../services/pane-turn-registry";

function makeProps(overrides?: Partial<CanvasAgentNodeData>) {
  return {
    id: "agent-1",
    data: {
      agentDefId: "def-1",
      name: "Rin",
      model: "claude-sonnet",
      cwd: "/repo",
      prompt: "",
      agentNumber: 1,
      executionMode: "live",
      appliedSkills: [],
      runner: "claude",
      permissionMode: "full",
      ...overrides,
    },
    selected: false,
  } as unknown as Parameters<typeof LiveAgentNode>[0];
}

describe("LiveAgentNode direct terminal interaction", () => {
  it("claims mousedown and focuses xterm before focus mode is entered", async () => {
    const { unmount } = render(<LiveAgentNode {...makeProps()} />);
    try {
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      const { Terminal } = await import("@xterm/xterm");
      const term = vi.mocked(Terminal).mock.results.at(-1)?.value as { focus: ReturnType<typeof vi.fn> };
      const body = screen.getByTestId("live-agent-body");
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      const stopSpy = vi.spyOn(event, "stopPropagation");

      act(() => { body.dispatchEvent(event); });

      expect(stopSpy).toHaveBeenCalledOnce();
      expect(term.focus).toHaveBeenCalledOnce();
    } finally {
      unmount();
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      mockUsePtySession.mockClear();
    }
  });
});

describe("LiveAgentNode Canvas browser env", () => {
  it("passes its node id as canvasTerminalId to the PTY session", () => {
    render(<LiveAgentNode {...makeProps()} />);

    expect(mockUsePtySession).toHaveBeenCalledWith(expect.objectContaining({
      paneId: "agent-1",
      canvasTerminalId: "agent-1",
    }));
  });
});

describe("LiveAgentNode runner identity", () => {
  it("shows a custom Claude-family runner by its registry identity", async () => {
    vi.mocked(runnerRegistryCache.listRunners).mockResolvedValueOnce({
      runners: [{
        id: "custom-hss",
        name: "HSS",
        installed: true,
        path: null,
        command: "ccs initech --dangerously-skip-permissions",
        skip_permissions: true,
        extra_flags: "",
        resume_on_reopen: true,
        custom: true,
        claude_family: true,
      }],
    });

    render(<LiveAgentNode {...makeProps({
      runner: "custom",
      runnerCommand: "ccs initech --dangerously-skip-permissions",
    })} />);

    await waitFor(() => expect(screen.getByLabelText("HSS — idle")).toHaveAttribute("data-mark", "logo"));
  });
});

describe("LiveAgentNode account chip", () => {
  const usage = (account: string, inUse = false) => ({ provider: "claude", account, plan: null, inUse, windows: [], error: null });
  // Opening the chip reads both again, so they stay mocked for the whole test.
  const accounts = (isolated: string[] = []) => {
    vi.mocked(getUsageSnapshot).mockResolvedValue([usage("acme", true), usage("globex"), usage("client")] as never);
    vi.mocked(listAccounts).mockResolvedValue(isolated.map((id) => ({ id, context: "isolated" })) as never);
  };
  afterEach(() => {
    vi.mocked(getUsageSnapshot).mockResolvedValue([]);
    vi.mocked(listAccounts).mockResolvedValue([]);
  });

  it("restarts a running node on another account only after a confirm, holding the PTY until the switch lands", async () => {
    accounts();
    const onSwitchAccount = vi.fn();
    render(<LiveAgentNode {...makeProps({ account: "acme", onSwitchAccount })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Rin runs on acme" }));
    fireEvent.click(screen.getByRole("button", { name: /globex/ }));
    // No conversation captured yet: the confirm says it starts over rather than promising a resume.
    expect(screen.getByRole("alertdialog", { name: "Restart Rin on globex? No conversation is saved yet, so it starts fresh." })).toBeInTheDocument();
    expect(onSwitchAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));

    await waitFor(() => expect(onSwitchAccount).toHaveBeenCalledWith("agent-1", "globex"));
    expect(mockUsePtySession).toHaveBeenLastCalledWith(expect.objectContaining({ hold: true }));
  });

  it("moves a dormant node without asking, and never onto an Isolated account its conversation cannot reach", async () => {
    accounts(["client"]);
    const onSwitchAccount = vi.fn();
    // A saved conversation and no pooled PTY: the node starts dormant, with no process to restart.
    render(<LiveAgentNode {...makeProps({ account: "acme", resumeSessionId: "s1", onSwitchAccount })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Rin runs on acme" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /client/ })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /globex/ }));
    expect(onSwitchAccount).toHaveBeenCalledWith("agent-1", "globex");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("LiveAgentNode focus mode action", () => {
  it("routes the header Focus action through the focus-node command", () => {
    const dispatchCommand = vi.fn();
    render(<LiveAgentNode {...makeProps({ dispatchCommand })} />);
    const props = headerProps[headerProps.length - 1];
    expect(typeof props.onFocusMode).toBe("function");
    (props.onFocusMode as () => void)();
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "focus-node", nodeId: "agent-1" });
  });

  it("hides the Focus action when no command dispatcher is wired", () => {
    render(<LiveAgentNode {...makeProps()} />);
    const props = headerProps[headerProps.length - 1];
    expect(props.onFocusMode).toBeUndefined();
  });
});

describe("LiveAgentNode output rendering", () => {
  it("coalesces PTY output received in one frame into one xterm write", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });

    try {
      const runFrame = (now: number) => {
        const callbacks = frames.splice(0);
        act(() => callbacks.forEach((callback) => callback(now)));
      };
      const { Terminal } = await import("@xterm/xterm");
      render(<LiveAgentNode {...makeProps()} />);
      await waitFor(() => expect(vi.mocked(Terminal)).toHaveBeenCalled());

      // Complete the initial fit/paint frame so subsequent PTY output targets
      // the live renderer rather than the pre-mount replay buffer.
      runFrame(0);
      const term = vi.mocked(Terminal).mock.results.at(-1)?.value as {
        write: ReturnType<typeof vi.fn>;
      };
      term.write.mockClear();
      const options = mockUsePtySession.mock.calls.at(-1)?.[0] as {
        onOutput: (chunk: string) => void;
      };

      act(() => {
        options.onOutput("first");
        options.onOutput("second");
      });

      expect(term.write).not.toHaveBeenCalled();
      runFrame(16);
      expect(term.write).toHaveBeenCalledOnce();
      expect(term.write).toHaveBeenCalledWith("firstsecond");
    } finally {
      requestFrame.mockRestore();
    }
  });
});

describe("LiveAgentNode stalled status recovery", () => {
  // The byte-idle stall backstop only runs for runners that report no per-step hook events, so these
  // tests need one. They used `cursor` until 45cdccd4 (2026-08-27) found Cursor fires the
  // Claude-format tool hooks and made it `reportsSteps: true`: since then PTY silence is not
  // evidence of a Cursor hang, and a never-asked Cursor pane at its prompt publishes `idle`.
  const STEP_SILENT_RUNNER = { runner: "custom", runnerCommand: "opencode" } as const;

  function mockConnectedPty() {
    mockUsePtySession.mockImplementation(() => ({
      sessionId: "session-1",
      status: "connected",
      mode: "command",
      write: vi.fn(),
      writeConfirmed: vi.fn(async () => undefined),
      resize: vi.fn(),
      reattached: false,
    } as never));
  }

  function restoreConnectingPty() {
    mockUsePtySession.mockImplementation(() => ({
      sessionId: null,
      status: "connecting",
      mode: null,
      write: vi.fn(),
      resize: vi.fn(),
    }));
  }

  function latestPtyOptions(): { onOutput: (chunk: string) => void } {
    const calls = mockUsePtySession.mock.calls as unknown as Array<
      [{ onOutput: (chunk: string) => void }]
    >;
    return calls.at(-1)![0];
  }

  function statusOfAgent(): string | undefined {
    return agentStatusRegistry.list().find((snapshot) => snapshot.id === "agent-1")?.status;
  }

  function cleanStatusRegistry(publish: ReturnType<typeof vi.spyOn>) {
    agentStatusRegistry.remove("agent-1");
    paneTurnRegistry.clear("agent-1");
    publish.mockRestore();
  }

  it("publishes running again when PTY output resumes after a stalled timeout", async () => {
    vi.useFakeTimers();
    const publish = vi.spyOn(agentStatusRegistry, "publish");
    agentStatusRegistry.remove("agent-1");
    mockConnectedPty();

    try {
      await act(async () => {
        render(<LiveAgentNode {...makeProps(STEP_SILENT_RUNNER)} />);
        await Promise.resolve();
      });

      const options = latestPtyOptions();
      act(() => options.onOutput("OpenCode\n> "));
      expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: "running" }));

      paneTurnRegistry.closeTurn("agent-1");
      act(() => vi.advanceTimersByTime(30_000));
      expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: "stalled" }));

      act(() => options.onOutput("Sprouting…\n"));
      expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: "running" }));
    } finally {
      restoreConnectingPty();
      cleanStatusRegistry(publish);
      vi.useRealTimers();
    }
  });

  it("does not call a step-reporting Claude turn stalled from silence alone", async () => {
    vi.useFakeTimers();
    const publish = vi.spyOn(agentStatusRegistry, "publish");
    agentStatusRegistry.remove("agent-1");
    mockConnectedPty();

    try {
      await act(async () => {
        render(<LiveAgentNode {...makeProps({ runner: "claude" })} />);
        await Promise.resolve();
      });

      const options = latestPtyOptions();
      act(() => options.onOutput("? for shortcuts\n"));
      // `idle`, not `running`. This pane has reached its prompt and nobody has asked it anything;
      // `TONE_TO_STATUS` calls a settled `ready` pane busy on purpose, as the input the resolver
      // corrects, and since 2026-08-27 that correction also covers a pane with no hook fact at all.
      // Claude reports every step by hook, so a real turn announces itself immediately.
      expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: "idle" }));

      act(() => vi.advanceTimersByTime(30_000));
      // The point of this test, unchanged: silence alone must not escalate a step-reporting runner.
      // Asserted as "not stalled" as well as the exact status, because that is what the name claims.
      expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: "idle" }));
      expect(publish).not.toHaveBeenCalledWith(expect.objectContaining({ status: "stalled" }));
    } finally {
      restoreConnectingPty();
      cleanStatusRegistry(publish);
      vi.useRealTimers();
    }
  });

  it("publishes running as soon as a new submit reopens a stalled runner turn", async () => {
    vi.useFakeTimers();
    const publish = vi.spyOn(agentStatusRegistry, "publish");
    agentStatusRegistry.remove("agent-1");
    mockConnectedPty();

    try {
      await act(async () => {
        render(<LiveAgentNode {...makeProps(STEP_SILENT_RUNNER)} />);
        await Promise.resolve();
      });

      const options = latestPtyOptions();
      act(() => options.onOutput("OpenCode\n> "));
      paneTurnRegistry.closeTurn("agent-1");
      act(() => vi.advanceTimersByTime(30_000));
      expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: "stalled" }));

      const term = vi.mocked(Terminal).mock.results.at(-1)?.value as {
        onData: { mock: { calls: [[(data: string) => void]] } };
      };
      const onData = term.onData.mock.calls[0][0];
      act(() => onData("\r"));

      expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ status: "running" }));
    } finally {
      restoreConnectingPty();
      cleanStatusRegistry(publish);
      vi.useRealTimers();
    }
  });

  it("keeps a submitted OpenCode turn running while the turn window is still open", async () => {
    vi.useFakeTimers();
    const publish = vi.spyOn(agentStatusRegistry, "publish");
    agentStatusRegistry.remove("agent-1");
    mockConnectedPty();

    try {
      await act(async () => {
        render(<LiveAgentNode {...makeProps({ runner: "custom", runnerCommand: "opencode" })} />);
        await Promise.resolve();
      });

      const options = latestPtyOptions();
      act(() => options.onOutput("OpenCode\n> "));

      const term = vi.mocked(Terminal).mock.results.at(-1)?.value as {
        onData: { mock: { calls: [[(data: string) => void]] } };
      };
      const onData = term.onData.mock.calls[0][0];
      act(() => onData("run the focused tests\r"));
      expect(statusOfAgent()).toBe("running");

      act(() => vi.advanceTimersByTime(19 * 60_000));
      act(() => options.onOutput("Running tests…\n"));
      act(() => vi.advanceTimersByTime(19 * 60_000));
      expect(statusOfAgent()).toBe("running");
    } finally {
      restoreConnectingPty();
      cleanStatusRegistry(publish);
      vi.useRealTimers();
    }
  });

  it("reconciles an externally stale registry snapshot when PTY output is active", async () => {
    const publish = vi.spyOn(agentStatusRegistry, "publish");
    agentStatusRegistry.remove("agent-1");
    mockConnectedPty();

    try {
      await act(async () => {
        render(<LiveAgentNode {...makeProps({ runner: "custom", runnerCommand: "opencode" })} />);
        await Promise.resolve();
      });

      const options = latestPtyOptions();
      act(() => options.onOutput("OpenCode\n> "));
      expect(statusOfAgent()).toBe("running");

      act(() => agentStatusRegistry.publish({
        id: "agent-1",
        name: "Rin",
        status: "stalled",
        sessionId: "session-1",
      }));
      expect(statusOfAgent()).toBe("stalled");

      act(() => options.onOutput("Running tests…\n"));
      expect(statusOfAgent()).toBe("running");
    } finally {
      restoreConnectingPty();
      cleanStatusRegistry(publish);
    }
  });
});

describe("LiveAgentNode Shift+Enter newline wiring", () => {
  it("passes newline options resolving to the kitty encoding for a claude runner", async () => {
    const { Terminal } = await import("@xterm/xterm");
    const { handleTerminalCustomKeyEvent, KITTY_SHIFT_ENTER_SEQUENCE } = await import(
      "@/modules/codespace/services/terminal-keybindings"
    );
    const handleMock = vi.mocked(handleTerminalCustomKeyEvent);
    handleMock.mockClear();

    render(<LiveAgentNode {...makeProps({ runner: "claude" })} />);

    const instances = vi.mocked(Terminal).mock.results;
    const term = instances[instances.length - 1]?.value as {
      attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
    };
    expect(term.attachCustomKeyEventHandler).toHaveBeenCalledOnce();

    const keyHandler = term.attachCustomKeyEventHandler.mock.calls[0][0] as (event: unknown) => boolean;
    keyHandler({ type: "keydown", key: "Enter", shiftKey: true });

    expect(handleMock).toHaveBeenCalledOnce();
    const newlineOptions = handleMock.mock.calls[0][3];
    expect(newlineOptions?.shiftEnterSequence?.()).toBe(KITTY_SHIFT_ENTER_SEQUENCE);
  });
});

/**
 * Opaque floor + WebGL (plans/canvas-terminal-opaque-floor).
 *
 * The node used to build xterm with `allowTransparency: true` and no renderer addon, which
 * pinned it to WebKit's DOM renderer with per-cell alpha compositing — measured at 30% of the
 * webview main thread in CoreText shaping and WebCore layout, with JS at only 4.2%.
 */
describe("LiveAgentNode terminal floor", () => {
  it("builds xterm opaque so the renderer can take the background-run fast path", async () => {
    const { Terminal } = await import("@xterm/xterm");
    vi.mocked(Terminal).mockClear();

    render(<LiveAgentNode {...makeProps()} />);

    const options = vi.mocked(Terminal).mock.calls[0][0] as {
      allowTransparency?: boolean;
      theme?: { background?: string };
    };
    expect(options.allowTransparency).toBe(false);
  });

  it("paints on the theme's resolved floor, not a transparent stand-in", async () => {
    const { Terminal } = await import("@xterm/xterm");
    const { resolveTerminalFloor } = await import(
      "@/modules/codecanvas/services/theme/terminal-floor"
    );
    const { defaultCanvasTheme } = await import(
      "@/modules/codecanvas/services/theme/builtin-themes"
    );
    vi.mocked(Terminal).mockClear();

    render(<LiveAgentNode {...makeProps()} />);

    const options = vi.mocked(Terminal).mock.calls[0][0] as { theme?: { background?: string } };
    // xterm cannot read CSS variables — the background has to be a literal, and it has to be
    // the SAME literal the CSS viewport uses, or the node shows a seam.
    expect(options.theme?.background).toBe(resolveTerminalFloor(defaultCanvasTheme()).background);
    expect(options.theme?.background).not.toBe("rgba(0, 0, 0, 0)");
  });
});

describe("LiveAgentNode typography", () => {
  it("builds xterm on the shared canvas terminal type scale", async () => {
    // Both canvas terminal families read one scale. This node used to hardcode 12/1.3 while the
    // Terminal Node ran 13/1.12, so two nodes of the same family sat side by side at visibly
    // different sizes.
    const { Terminal } = await import("@xterm/xterm");
    const { CANVAS_TERMINAL_TYPOGRAPHY } = await import(
      "@/modules/codecanvas/services/canvas-terminal-typography"
    );
    vi.mocked(Terminal).mockClear();

    render(<LiveAgentNode {...makeProps()} />);

    const options = vi.mocked(Terminal).mock.calls[0][0] as Record<string, unknown>;
    expect(options.fontSize).toBe(CANVAS_TERMINAL_TYPOGRAPHY.fontSize);
    expect(options.lineHeight).toBe(CANVAS_TERMINAL_TYPOGRAPHY.lineHeight);
    expect(options.letterSpacing).toBe(CANVAS_TERMINAL_TYPOGRAPHY.letterSpacing);
    expect(options.fontWeight).toBe(CANVAS_TERMINAL_TYPOGRAPHY.fontWeight);
    expect(options.fontWeightBold).toBe(CANVAS_TERMINAL_TYPOGRAPHY.fontWeightBold);
  });

  it("leads the font stack with JetBrains Mono and keeps the Nerd Font fallbacks", async () => {
    const { Terminal } = await import("@xterm/xterm");
    vi.mocked(Terminal).mockClear();

    render(<LiveAgentNode {...makeProps()} />);

    const options = vi.mocked(Terminal).mock.calls[0][0] as { fontFamily?: string };
    expect(options.fontFamily?.startsWith('"JetBrains Mono"')).toBe(true);
    // A private-use prompt glyph must not fall straight through to 'Apple Symbols'.
    expect(options.fontFamily).toMatch(/monospace$/);
  });

  it("re-measures the glyph cell once the webfont swaps in", async () => {
    // fontsource ships font-display: swap. xterm measures the cell in its constructor, so a node
    // mounted on the first frame sizes itself against Menlo and keeps that width — the columns
    // stay wrong until something forces a re-measure.
    //
    // Asserting on the final `term.options.fontFamily` value would NOT catch the real bug here:
    // re-assigning the cached stack onto a terminal already constructed with it leaves the option
    // correct and the cell stale, because xterm's setter is guarded on `!==`. So assert the node
    // routes through the helper whose job is to move the value — see the service suite.
    const { Terminal } = await import("@xterm/xterm");
    vi.mocked(Terminal).mockClear();
    mockForceFontFamilyRemeasure.mockClear();

    const check = vi.fn(() => false);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve(), check },
    });

    render(<LiveAgentNode {...makeProps()} />);

    await waitFor(() => expect(check).toHaveBeenCalled());
    await waitFor(() => expect(mockForceFontFamilyRemeasure).toHaveBeenCalledTimes(1));

    // The helper is handed a setter that lands on the terminal xterm actually built.
    const term = vi.mocked(Terminal).mock.results.at(-1)?.value as {
      options: Record<string, unknown>;
    };
    const setFontFamily = mockForceFontFamilyRemeasure.mock.calls[0][0] as (f: string) => void;
    setFontFamily("probe-face");
    expect(term.options.fontFamily).toBe("probe-face");
  });

  it("skips the re-measure entirely when the face was already resident", async () => {
    // A forced re-measure is a full glyph re-measure plus a refit. Paying that on every mount
    // when JetBrains Mono is already loaded would be pure waste on the busiest path.
    const { Terminal } = await import("@xterm/xterm");
    vi.mocked(Terminal).mockClear();
    mockForceFontFamilyRemeasure.mockClear();

    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve(), check: vi.fn(() => true) },
    });

    render(<LiveAgentNode {...makeProps()} />);

    await new Promise((r) => setTimeout(r, 0));
    expect(mockForceFontFamilyRemeasure).not.toHaveBeenCalled();
  });
});

describe("LiveAgentNode unmount safety", () => {
  /**
   * React StrictMode (Next's dev default) mounts → unmounts → remounts every node, so every
   * deferred callback in the mount effect gets a chance to run against a terminal that cleanup
   * already disposed. Real xterm clears its internals on dispose, so `term.buffer` throws
   * "undefined is not an object" — which is exactly the error seen in the dev terminal logs,
   * stacked through repositionDeliveryTarget.
   */

  /** rAF stand-in that honours cancellation, so a cancelled frame really does not run. */
  function installFrameScheduler() {
    const frames = new Map<number, FrameRequestCallback>();
    let next = 1;
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((cb: FrameRequestCallback) => {
        const id = next++;
        frames.set(id, cb);
        return id;
      });
    const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
      frames.delete(id);
    });
    return {
      /** Run every frame still scheduled, draining any it schedules in turn. */
      flush() {
        for (let guard = 0; guard < 10 && frames.size; guard += 1) {
          const pending = [...frames.entries()];
          frames.clear();
          for (const [, cb] of pending) cb(0);
        }
      },
      pending: () => frames.size,
      restore() {
        raf.mockRestore();
        caf.mockRestore();
      },
    };
  }

  it("cancels its deferred paint frame on unmount", async () => {
    // The reattach-paint frame was scheduled with its handle discarded, so nothing could cancel
    // it. Only repositionRaf was tracked.
    const sched = installFrameScheduler();
    try {
      const { unmount } = render(<LiveAgentNode {...makeProps()} />);
      expect(sched.pending()).toBeGreaterThan(0);
      unmount();
      expect(sched.pending()).toBe(0);
    } finally {
      sched.restore();
    }
  });

  it("does not read a disposed terminal from a stale frame after a StrictMode remount", async () => {
    // This is the shape of the real dev failure, and it is NOT the plain-unmount case: on unmount
    // the DOM refs go null and repositionDeliveryTarget early-returns before reaching term.buffer.
    // StrictMode instead re-runs the effect against the SAME DOM — so the refs stay live while the
    // FIRST terminal is already disposed, and a stale frame closes over that dead terminal.
    const sched = installFrameScheduler();
    try {
      const { Terminal } = await import("@xterm/xterm");
      vi.mocked(Terminal).mockClear();

      render(
        <StrictMode>
          <LiveAgentNode {...makeProps()} />
        </StrictMode>,
      );

      const instances = vi.mocked(Terminal).mock.results.map((r) => r.value as object);
      expect(instances.length).toBeGreaterThan(1);

      // Mirror real xterm: the first instance is disposed, so its buffer accessor no longer resolves.
      Object.defineProperty(instances[0], "buffer", {
        configurable: true,
        get() {
          throw new TypeError("undefined is not an object (evaluating 'this.buffers.active')");
        },
      });

      expect(() => sched.flush()).not.toThrow();
    } finally {
      sched.restore();
    }
  });
});

describe("LiveAgentNode WebGL staleness", () => {
  it("hands the activator a staleness predicate that trips once the terminal is gone", async () => {
    // activateWebglRenderer awaits a dynamic import, so it can reach loadAddon after cleanup has
    // already disposed the terminal. A guard checked only in the .then() is too late — the throw
    // happens inside the activator. So the predicate has to travel INTO it.
    mockActivateWebglRenderer.mockClear();

    const { unmount } = render(<LiveAgentNode {...makeProps()} />);
    await waitFor(() => expect(mockActivateWebglRenderer).toHaveBeenCalled());

    // The mock is declared with no parameters, so its `calls` are typed as empty tuples — widen
    // through `unknown` rather than indexing a `[]` (the pattern the rest of this file uses trips
    // tsc; no reason to add more).
    const calls = mockActivateWebglRenderer.mock.calls as unknown as Array<
      [unknown, { isStale?: () => boolean }]
    >;
    const opts = calls.at(-1)?.[1];
    expect(typeof opts?.isStale).toBe("function");
    expect(opts?.isStale?.()).toBe(false);

    unmount();
    expect(opts?.isStale?.()).toBe(true);
  });
});

describe("LiveAgentNode WebGL adoption", () => {
  it("asks for acceleration as the canvas surface", async () => {
    mockActivateWebglRenderer.mockClear();

    render(<LiveAgentNode {...makeProps()} />);

    await waitFor(() => expect(mockActivateWebglRenderer).toHaveBeenCalled());
    const context = mockActivateWebglRenderer.mock.calls[0][1] as { surface?: string };
    // Without this the codespace branch applies and the blanket Tauri disable makes the whole
    // call a silent no-op in the desktop app.
    expect(context.surface).toBe("canvas");
  });

  it("requests acceleration for every node, regardless of selection", () => {
    // Selection used to drive this, which swapped the node between the WebGL and DOM renderers
    // on every focus change — and the two rasterise glyphs differently, so box-drawing and ASCII
    // art visibly shifted. An unselected node must still be accelerated.
    mockActivateWebglRenderer.mockClear();

    render(<LiveAgentNode {...makeProps()} />);

    return waitFor(() => {
      expect(mockActivateWebglRenderer).toHaveBeenCalled();
      expect(
        (mockActivateWebglRenderer.mock.calls[0][1] as { activePaneEligible?: boolean })
          .activePaneEligible,
      ).toBe(true);
    });
  });

  it("does not re-activate when selection changes", async () => {
    mockActivateWebglRenderer.mockClear();

    const { rerender } = render(<LiveAgentNode {...makeProps()} />);
    await waitFor(() => expect(mockActivateWebglRenderer).toHaveBeenCalledTimes(1));

    const selected = { ...makeProps(), selected: true } as Parameters<typeof LiveAgentNode>[0];
    rerender(<LiveAgentNode {...selected} />);
    rerender(<LiveAgentNode {...makeProps()} />);

    // One activation for the node's whole lifetime — no swap on focus, none on blur.
    expect(mockActivateWebglRenderer).toHaveBeenCalledTimes(1);
  });

  it("never caps acceleration, so no two nodes on a board render differently", async () => {
    // With a cap of 6 and 8 agent nodes, two rendered with the DOM renderer while six used
    // WebGL — visible as different ASCII art side by side. Any cap reproduces that.
    mockActivateWebglRenderer.mockClear();

    for (let i = 0; i < 12; i++) {
      const props = { ...makeProps(), id: `agent-${i}` } as Parameters<typeof LiveAgentNode>[0];
      render(<LiveAgentNode {...props} />);
    }

    await waitFor(() => expect(mockActivateWebglRenderer).toHaveBeenCalledTimes(12));
    for (const call of mockActivateWebglRenderer.mock.calls) {
      expect((call[1] as { activePaneEligible?: boolean }).activePaneEligible).toBe(true);
    }
  });


  it("supplies an onLost handler so a dropped context does not freeze the viewport", async () => {
    mockActivateWebglRenderer.mockClear();

    render(<LiveAgentNode {...makeProps()} />);

    await waitFor(() => expect(mockActivateWebglRenderer).toHaveBeenCalled());
    const context = mockActivateWebglRenderer.mock.calls[0][1] as { onLost?: () => void };
    expect(typeof context.onLost).toBe("function");
    // The addon is already disposed when this fires; it must not throw on the way out.
    expect(() => context.onLost?.()).not.toThrow();
  });
});

describe("LiveAgentNode renderer diagnostic", () => {
  it("labels the host with the renderer it actually got", async () => {
    // Two nodes on one board rendering glyphs differently is only debuggable if each says
    // which renderer it ended up on.
    mockActivateWebglRenderer.mockClear();

    const { getByTestId } = render(<LiveAgentNode {...makeProps()} />);

    await waitFor(() => expect(getByTestId("pty-viewport").dataset.renderer).toBe("webgl"));
  });

  it("labels the host dom when acceleration is declined", async () => {
    mockActivateWebglRenderer.mockClear();
    mockActivateWebglRenderer.mockResolvedValueOnce(null as never);

    const { getByTestId } = render(<LiveAgentNode {...makeProps()} />);

    await waitFor(() => expect(getByTestId("pty-viewport").dataset.renderer).toBe("dom"));
  });
});

describe("LiveAgentNode perf instrumentation", () => {
  it("stays out of the write path unless measurement is switched on", async () => {
    // The probe times every write and runs a permanent rAF loop. Paying that on the very path
    // being optimised would corrupt the thing it measures, so a normal run must not.
    window.localStorage.removeItem("lotus.terminal.perf");
    const { Terminal } = await import("@xterm/xterm");
    vi.mocked(Terminal).mockClear();

    render(<LiveAgentNode {...makeProps()} />);
    const term = vi.mocked(Terminal).mock.results.at(-1)?.value as {
      write: ReturnType<typeof vi.fn>;
    };
    term.write.mockClear();
    const options = mockUsePtySession.mock.calls.at(-1)?.[0] as { onOutput: (c: string) => void };
    act(() => options.onOutput("hello"));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    for (const call of term.write.mock.calls) {
      expect(call).toHaveLength(1);
    }
    expect((window as unknown as Record<string, unknown>).__lotusTerminalPerf).toBeUndefined();
  });
});

describe("LiveAgentNode records the ask an operator types", () => {
  // The seam test for headlines on every runner (`plans/agent-headlines/`). Claude-family panes get
  // their ask from a `prompt-submit` hook drop; codex reports only turn ends and cursor/custom report
  // nothing, so for most of a mixed board the ask has to be read from the write stream itself.
  //
  // Driven through the real `onData` handler the component registers on xterm, because the thing
  // being proven is the wiring — that typing reaches the buffer and a completed line reaches the
  // recorder. The buffer's own behaviour (backspace, paste, Shift+Enter) is proven in
  // `pane-ask-buffer.test.ts`, where it can be tested exhaustively without a DOM.

  const typeInto = (onData: (d: string) => void, text: string) => {
    act(() => {
      for (const char of text) onData(char);
    });
  };

  const mountAndGetOnData = () => {
    render(<LiveAgentNode {...makeProps()} />);
    const term = vi.mocked(Terminal).mock.results.at(-1)?.value as {
      onData: { mock: { calls: [(d: string) => void][] } };
    };
    return term.onData.mock.calls[0][0];
  };

  it("hands the finished line to the recorder", async () => {
    vi.mocked(noteAgentAsk).mockClear();
    const onData = mountAndGetOnData();

    typeInto(onData, "perbaiki judul agent\r");

    await waitFor(() =>
      expect(noteAgentAsk).toHaveBeenCalledWith(expect.any(String), "perbaiki judul agent"),
    );
  });

  it("stays quiet while the line is still being typed", () => {
    vi.mocked(noteAgentAsk).mockClear();
    const onData = mountAndGetOnData();

    typeInto(onData, "setengah jadi");

    expect(noteAgentAsk).not.toHaveBeenCalled();
  });

  it("attributes the ask to the pane, not the node id", () => {
    // The headline store, the turn registry and the fleet all key on LOTUS_PANE_ID. Recording under
    // the ReactFlow node id would file the ask where nothing reads it.
    vi.mocked(noteAgentAsk).mockClear();
    const onData = mountAndGetOnData();

    typeInto(onData, "halo\r");

    const [paneId] = vi.mocked(noteAgentAsk).mock.calls[0];
    expect(paneId).toContain("agent-1");
  });
});

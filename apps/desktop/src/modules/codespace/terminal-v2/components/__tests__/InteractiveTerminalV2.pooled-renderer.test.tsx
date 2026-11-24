import { createRef } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_V2_POOLED_CUSTOM_KEY_EVENT,
  TERMINAL_V2_POOLED_LINK_CONTEXT_MENU_EVENT,
  type TerminalV2PooledCustomKeyDetail,
} from "@/modules/codespace/terminal-v2/rendering/terminal-v2-pooled-xterm-renderer-factory";
import { InteractiveTerminalV2, type InteractiveTerminalHandle } from "../InteractiveTerminalV2";

const registerPooledRendererPaneContainer = vi.fn(() => vi.fn());
const focusPaneRenderer = vi.fn(() => false);
const getPaneRendererHelperTextarea = vi.fn(() => null as HTMLTextAreaElement | null);
const runtimeContext = {
  runtime: {
    focusPaneRenderer,
    getPaneRendererHelperTextarea,
    installPooledDomSlotFactory: vi.fn(() => vi.fn()),
    registerPooledRendererPaneContainer,
  },
  pooledRendererEnabled: true,
};
const bridgeFocus = vi.fn();
const bridgeContainerRef = { current: null as HTMLDivElement | null };
const nativeContainerRef = { current: null as HTMLDivElement | null };
const bridgeRuntimeHook = vi.fn((options: unknown) => {
  void options;
  return {
    containerRef: bridgeContainerRef,
    helperTextareaRef: { current: null },
    revealState: "settled",
    write: vi.fn(),
    focus: bridgeFocus,
    fit: vi.fn(),
    fitViewport: vi.fn(),
  };
});
const nativeRuntimeHook = vi.fn((options: unknown) => {
  void options;
  return {
    containerRef: nativeContainerRef,
    helperTextareaRef: { current: null },
    revealState: "settled",
    write: vi.fn(),
    focus: vi.fn(),
    fit: vi.fn(),
    fitViewport: vi.fn(),
  };
});
let runtimePolicyKind: "bridge" | "native" = "bridge";
const resolveNativeRuntimePolicy = vi.fn((input: unknown) => {
  void input;
  return { kind: runtimePolicyKind, reason: "test" };
});

vi.mock("@/modules/codespace/terminal-v2/hooks/useTerminalV2LegacyBridgeFallbackRuntime", () => ({
  useTerminalV2LegacyBridgeFallbackRuntime: (options: unknown) => bridgeRuntimeHook(options),
}));

vi.mock("@/modules/codespace/terminal-v2/hooks/useTerminalV2NativeRuntime", () => ({
  useTerminalV2NativeRuntime: (options: unknown) => nativeRuntimeHook(options),
}));

vi.mock("../terminal-v2-native-runtime-policy", () => ({
  resolveTerminalV2NativeRuntimePolicy: (input: unknown) => resolveNativeRuntimePolicy(input),
}));

vi.mock("@/modules/codespace/terminal-v2/hooks/useTerminalV2RendererDiagnostics", () => ({
  useTerminalV2RendererDiagnosticsEnabled: () => false,
  useTerminalV2RendererDiagnostics: () => ({ leases: [], registeredSlots: [], waitingPanes: [], fallbackPanes: [] }),
  useTerminalV2RuntimeDiagnostics: () => null,
}));

vi.mock("@/modules/codespace/terminal-v2/runtime/TerminalV2RuntimeProvider", () => ({
  useOptionalTerminalV2Runtime: () => runtimeContext,
}));

vi.mock("@/lib/tauri-api", () => ({
  openExternalLink: vi.fn(),
  openPathInEditor: vi.fn(),
}));

describe("InteractiveTerminalV2 pooled renderer wiring", () => {
  beforeEach(() => {
    runtimePolicyKind = "bridge";
    registerPooledRendererPaneContainer.mockClear();
    bridgeFocus.mockClear();
    focusPaneRenderer.mockReset();
    focusPaneRenderer.mockReturnValue(false);
    getPaneRendererHelperTextarea.mockReset();
    getPaneRendererHelperTextarea.mockReturnValue(null);
    bridgeRuntimeHook.mockClear();
    nativeRuntimeHook.mockClear();
    resolveNativeRuntimePolicy.mockClear();
  });

  it("registers its pane container with the runtime-level pooled renderer registry", async () => {
    render(<InteractiveTerminalV2 workspaceId="workspace-1" paneId="pane-1" cwd="/repo" />);

    await waitFor(() => {
      expect(registerPooledRendererPaneContainer).toHaveBeenCalledWith(
        "pane-1",
        expect.any(HTMLDivElement),
      );
    });
  });

  it("requests the all-environments native rollout policy and exposes renderer diagnostics attributes", () => {
    const { container } = render(<InteractiveTerminalV2 workspaceId="workspace-1" paneId="pane-1" cwd="/repo" />);

    expect(resolveNativeRuntimePolicy).toHaveBeenCalledWith({
      rolloutMode: "default-on-all-environments",
    });
    expect(container.querySelector(".codespace-interactive-terminal")).toHaveAttribute("data-terminal-v2-runtime-policy", "bridge");
    expect(container.querySelector(".codespace-interactive-terminal")).toHaveAttribute("data-terminal-v2-pooled-renderer", "enabled");
  });

  it("forwards pane focus state into the selected runtime hook", () => {
    render(<InteractiveTerminalV2 workspaceId="workspace-1" paneId="pane-1" cwd="/repo" focused={false} />);

    expect(bridgeRuntimeHook).toHaveBeenCalledWith(expect.objectContaining({ focused: false }));
  });

  it("uses the bridge runtime when the rollout policy falls back", () => {
    render(<InteractiveTerminalV2 workspaceId="workspace-1" paneId="pane-1" cwd="/repo" />);

    expect(bridgeRuntimeHook).toHaveBeenCalledOnce();
    expect(nativeRuntimeHook).not.toHaveBeenCalled();
  });

  it("uses the native runtime when the policy opts in", () => {
    runtimePolicyKind = "native";

    render(<InteractiveTerminalV2 workspaceId="workspace-1" paneId="pane-1" cwd="/repo" />);

    expect(nativeRuntimeHook).toHaveBeenCalledOnce();
    expect(bridgeRuntimeHook).not.toHaveBeenCalled();
  });

  it("forwards pooled custom key events to the pane custom key callback", () => {
    const onTerminalCustomKey = vi.fn(() => false);
    const { container } = render(
      <InteractiveTerminalV2 workspaceId="workspace-1" paneId="pane-1" cwd="/repo" onTerminalCustomKey={onTerminalCustomKey} />,
    );
    const root = container.querySelector(".codespace-interactive-terminal");
    if (!root) throw new Error("expected terminal root");
    const detail: TerminalV2PooledCustomKeyDetail = {
      event: new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true }),
      result: true,
    };

    root.dispatchEvent(new CustomEvent(TERMINAL_V2_POOLED_CUSTOM_KEY_EVENT, { bubbles: true, detail }));

    expect(onTerminalCustomKey).toHaveBeenCalledWith(detail.event);
    expect(detail.result).toBe(false);
  });

  it("opens the link context menu from pooled renderer link events", async () => {
    const { container } = render(<InteractiveTerminalV2 workspaceId="workspace-1" paneId="pane-1" cwd="/repo" />);
    const root = container.querySelector(".codespace-interactive-terminal");
    if (!root) throw new Error("expected terminal root");

    root.dispatchEvent(new CustomEvent(TERMINAL_V2_POOLED_LINK_CONTEXT_MENU_EVENT, {
      bubbles: true,
      detail: {
        clientX: 42,
        clientY: 64,
        link: { kind: "external", text: "https://example.com", start: 0, end: 19, url: "https://example.com/" },
      },
    }));

    expect(await screen.findByText("Open Link")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy Link" })).toBeInTheDocument();
  });

  it("prefers focusing the visible pooled renderer from its imperative handle", () => {
    focusPaneRenderer.mockReturnValue(true);
    const ref = createRef<InteractiveTerminalHandle>();

    render(<InteractiveTerminalV2 ref={ref} workspaceId="workspace-1" paneId="pane-1" cwd="/repo" />);
    act(() => {
      ref.current?.focus();
    });

    expect(focusPaneRenderer).toHaveBeenCalledWith("pane-1");
    expect(bridgeFocus).not.toHaveBeenCalled();
  });

  it("falls back to runtime focus when no pooled renderer is leased", () => {
    focusPaneRenderer.mockReturnValue(false);
    const ref = createRef<InteractiveTerminalHandle>();

    render(<InteractiveTerminalV2 ref={ref} workspaceId="workspace-1" paneId="pane-1" cwd="/repo" />);
    act(() => {
      ref.current?.focus();
    });

    expect(focusPaneRenderer).toHaveBeenCalledWith("pane-1");
    expect(bridgeFocus).toHaveBeenCalledOnce();
  });

  it("positions inline suggestions from the visible pooled renderer helper textarea", async () => {
    const pooledHelperTextarea = document.createElement("textarea");
    pooledHelperTextarea.getBoundingClientRect = vi.fn(() => ({
      left: 130,
      top: 86,
      right: 140,
      bottom: 106,
      width: 10,
      height: 20,
      x: 130,
      y: 86,
      toJSON: () => ({}),
    }));
    getPaneRendererHelperTextarea.mockReturnValue(pooledHelperTextarea);

    const { container } = render(<InteractiveTerminalV2 workspaceId="workspace-1" paneId="pane-1" cwd="/repo" />);
    const terminalHost = container.querySelector(".codespace-terminal-host") as HTMLDivElement | null;
    if (!terminalHost) throw new Error("expected terminal host");
    terminalHost.getBoundingClientRect = vi.fn(() => ({
      left: 100,
      top: 40,
      right: 500,
      bottom: 300,
      width: 400,
      height: 260,
      x: 100,
      y: 40,
      toJSON: () => ({}),
    }));
    const options = bridgeRuntimeHook.mock.calls.at(-1)?.[0] as {
      onSuggestionRemainderChange?: (remainder: string) => void;
    };

    await act(async () => {
      options.onSuggestionRemainderChange?.("--help");
    });

    const suggestion = await screen.findByText("--help");
    expect(getPaneRendererHelperTextarea).toHaveBeenCalledWith("pane-1");
    expect(suggestion).toHaveStyle({ left: "30px", top: "46px" });
  });

  it("keeps native runtime callback props stable across same-input rerenders", () => {
    runtimePolicyKind = "native";

    const { rerender } = render(<InteractiveTerminalV2 workspaceId="workspace-1" paneId="pane-1" cwd="/repo" />);
    const firstOptions = nativeRuntimeHook.mock.calls.at(-1)?.[0] as {
      history: unknown;
      onSuggestionRemainderChange: unknown;
      onSuggestionLayoutChange: unknown;
      onLinkContextMenu: unknown;
    };

    rerender(<InteractiveTerminalV2 workspaceId="workspace-1" paneId="pane-1" cwd="/repo" />);

    const secondOptions = nativeRuntimeHook.mock.calls.at(-1)?.[0] as {
      history: unknown;
      onSuggestionRemainderChange: unknown;
      onSuggestionLayoutChange: unknown;
      onLinkContextMenu: unknown;
    };
    expect(secondOptions.history).toBe(firstOptions.history);
    expect(secondOptions.onSuggestionRemainderChange).toBe(firstOptions.onSuggestionRemainderChange);
    expect(secondOptions.onSuggestionLayoutChange).toBe(firstOptions.onSuggestionLayoutChange);
    expect(secondOptions.onLinkContextMenu).toBe(firstOptions.onLinkContextMenu);
  });
});

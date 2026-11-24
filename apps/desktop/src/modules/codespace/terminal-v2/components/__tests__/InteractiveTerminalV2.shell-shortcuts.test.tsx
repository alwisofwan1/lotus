import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_V2_POOLED_CUSTOM_KEY_EVENT,
  type TerminalV2PooledCustomKeyDetail,
} from "@/modules/codespace/terminal-v2/rendering/terminal-v2-pooled-xterm-renderer-factory";
import type { TerminalShortcutEvent } from "@/modules/codespace/services/terminal-keybindings";
import { InteractiveTerminalV2 } from "../InteractiveTerminalV2";

const nativeWrite = vi.fn();
const registerPooledRendererPaneContainer = vi.fn(() => vi.fn());
const runtimeContext = {
  runtime: {
    focusPaneRenderer: vi.fn(() => false),
    getPaneRendererHelperTextarea: vi.fn(() => null),
    registerPooledRendererPaneContainer,
  },
  pooledRendererEnabled: true,
};

type NativeRuntimeOptions = {
  onTerminalCustomKey?: (event: TerminalShortcutEvent) => boolean | undefined;
};

const nativeRuntimeHook = vi.fn((options: NativeRuntimeOptions) => {
  void options;
  return {
    containerRef: { current: null as HTMLDivElement | null },
    helperTextareaRef: { current: null },
    revealState: "settled",
    write: nativeWrite,
    focus: vi.fn(),
    fit: vi.fn(),
    fitViewport: vi.fn(),
  };
});

vi.mock("@/modules/codespace/terminal-v2/hooks/useTerminalV2NativeRuntime", () => ({
  useTerminalV2NativeRuntime: (options: NativeRuntimeOptions) => nativeRuntimeHook(options),
}));

vi.mock("@/modules/codespace/terminal-v2/hooks/useTerminalV2LegacyBridgeFallbackRuntime", () => ({
  useTerminalV2LegacyBridgeFallbackRuntime: (options: NativeRuntimeOptions) => nativeRuntimeHook(options),
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

function keyEvent(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

function renderPane(props: Partial<React.ComponentProps<typeof InteractiveTerminalV2>> = {}) {
  return render(
    <InteractiveTerminalV2 workspaceId="workspace-1" paneId="pane-1" cwd="/repo" {...props} />,
  );
}

function nativeCustomKeyHandler(): (event: TerminalShortcutEvent) => boolean | undefined {
  const options = nativeRuntimeHook.mock.calls.at(-1)?.[0];
  const handler = options?.onTerminalCustomKey;
  if (!handler) throw new Error("native runtime received no custom key handler");
  return handler;
}

describe("InteractiveTerminalV2 shell shortcut keys", () => {
  beforeEach(() => {
    nativeWrite.mockClear();
    nativeRuntimeHook.mockClear();
  });

  it("writes the readline sequence for Cmd+Backspace instead of leaving the key to xterm", () => {
    renderPane();

    const handled = nativeCustomKeyHandler()(keyEvent({ key: "Backspace", metaKey: true }));

    expect(nativeWrite).toHaveBeenCalledWith("\u0015");
    expect(handled).toBe(false);
  });

  it("writes the readline sequence for Cmd+Delete", () => {
    renderPane();

    nativeCustomKeyHandler()(keyEvent({ key: "Delete", metaKey: true }));

    expect(nativeWrite).toHaveBeenCalledWith("\u000b");
  });

  it("lets the pane owner claim a shortcut before the shell table sees it", () => {
    const onTerminalCustomKey = vi.fn(() => false);
    renderPane({ onTerminalCustomKey });

    const handled = nativeCustomKeyHandler()(keyEvent({ key: "Backspace", metaKey: true }));

    expect(onTerminalCustomKey).toHaveBeenCalled();
    expect(nativeWrite).not.toHaveBeenCalled();
    expect(handled).toBe(false);
  });

  it("leaves unmapped keys to xterm", () => {
    renderPane();

    const handled = nativeCustomKeyHandler()(keyEvent({ key: "a" }));

    expect(nativeWrite).not.toHaveBeenCalled();
    expect(handled).toBe(true);
  });

  it("inserts a newline on Shift+Enter in a plain shell pane", () => {
    renderPane();

    const handled = nativeCustomKeyHandler()(keyEvent({ key: "Enter", shiftKey: true }));

    expect(nativeWrite).toHaveBeenCalledWith("\u001b\r");
    expect(handled).toBe(false);
  });

  it("uses the kitty Shift+Enter encoding in a Claude-family agent pane", () => {
    renderPane({ agentCommand: "claude" });

    nativeCustomKeyHandler()(keyEvent({ key: "Enter", shiftKey: true }));

    expect(nativeWrite).toHaveBeenCalledWith("\u001b[13;2u");
  });

  it("leaves a plain Enter to the terminal so commands still submit", () => {
    renderPane();

    const handled = nativeCustomKeyHandler()(keyEvent({ key: "Enter" }));

    expect(nativeWrite).not.toHaveBeenCalled();
    expect(handled).toBe(true);
  });

  it("keeps typing alive when the pane owner's shortcut handler throws", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onTerminalCustomKey = vi.fn(() => {
      throw new Error("layout shortcut exploded");
    });
    renderPane({ onTerminalCustomKey });

    const handled = nativeCustomKeyHandler()(keyEvent({ key: "a" }));

    expect(handled).toBe(true);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("applies the same shell table to pooled renderer key events", () => {
    const { container } = renderPane();
    const host = container.querySelector(".codespace-interactive-terminal");
    if (!host) throw new Error("terminal host not rendered");

    const detail: TerminalV2PooledCustomKeyDetail = {
      event: keyEvent({ key: "ArrowLeft", metaKey: true }),
    };
    host.dispatchEvent(new CustomEvent(TERMINAL_V2_POOLED_CUSTOM_KEY_EVENT, { bubbles: true, detail }));

    expect(nativeWrite).toHaveBeenCalledWith("\u0001");
    expect(detail.result).toBe(false);
  });
});

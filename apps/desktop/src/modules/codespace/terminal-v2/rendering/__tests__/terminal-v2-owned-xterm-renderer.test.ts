import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalAddons } from "@/modules/codespace/services/terminal-addons";
import {
  createTerminalV2OwnedXtermRenderer,
  type CreateTerminalV2OwnedXtermRendererOptions,
  type TerminalV2OwnedXtermConstructor,
  type TerminalV2OwnedXtermTerminal,
} from "../terminal-v2-owned-xterm-renderer";

function createAddons(): TerminalAddons {
  return {
    fitAddon: { fit: vi.fn() },
    webLinksAddon: { dispose: vi.fn() },
    webglAddon: null,
    unicode11Addon: null,
    searchAddon: null,
    clipboardAddon: null,
    dispose: vi.fn(),
  } as unknown as TerminalAddons;
}

function createTerminalCtor(terminal: TerminalV2OwnedXtermTerminal) {
  let options: Record<string, unknown> | null = null;
  const constructorMock = vi.fn(function TerminalMock(receivedOptions: Record<string, unknown>) {
    options = receivedOptions;
    return terminal;
  }) as unknown as TerminalV2OwnedXtermConstructor;
  return { constructorMock, getOptions: () => options };
}

function createLoadAddonsMock(addons = createAddons()) {
  const loadAddonsMock = vi.fn(async () => addons);
  return {
    addons,
    loadAddonsMock,
    loadAddons: loadAddonsMock as unknown as NonNullable<CreateTerminalV2OwnedXtermRendererOptions["loadAddons"]>,
  };
}

describe("createTerminalV2OwnedXtermRenderer", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("creates and opens one xterm instance for a local V2 pane", async () => {
    const container = document.createElement("div");
    const terminal = { open: vi.fn(), dispose: vi.fn() };
    const { constructorMock: TerminalCtor, getOptions } = createTerminalCtor(terminal);
    const { addons, loadAddons, loadAddonsMock } = createLoadAddonsMock();

    const renderer = await createTerminalV2OwnedXtermRenderer({
      container,
      cwd: "/repo",
      fontSize: 13,
      allowTransparency: true,
      TerminalCtor,
      loadAddons,
    });

    expect(TerminalCtor).toHaveBeenCalledOnce();
    expect(getOptions()).toMatchObject({
      fontSize: 13,
      allowTransparency: true,
      scrollback: 5000,
    });
    expect(terminal.open).toHaveBeenCalledWith(container);
    expect(loadAddonsMock).toHaveBeenCalledWith(terminal, undefined, {
      cwd: "/repo",
      onLinkContextMenu: undefined,
    });
    expect(renderer.terminal).toBe(terminal);
    expect(renderer.addons).toBe(addons);
  });

  it("continues renderer creation when browser font readiness stalls", async () => {
    vi.useFakeTimers();
    const originalFonts = document.fonts;
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: new Promise(() => undefined) },
    });
    const container = document.createElement("div");
    const terminal = { open: vi.fn(), dispose: vi.fn() };
    const { constructorMock: TerminalCtor } = createTerminalCtor(terminal);
    const { loadAddons } = createLoadAddonsMock();

    try {
      const rendererPromise = createTerminalV2OwnedXtermRenderer({
        container,
        cwd: "/repo",
        fontSize: 12,
        TerminalCtor,
        loadAddons,
      });

      await vi.advanceTimersByTimeAsync(750);
      const renderer = await rendererPromise;

      expect(terminal.open).toHaveBeenCalledWith(container);
      expect(renderer.terminal).toBe(terminal);
    } finally {
      Object.defineProperty(document, "fonts", { configurable: true, value: originalFonts });
    }
  });

  it("captures the xterm helper textarea after opening", async () => {
    const container = document.createElement("div");
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    const terminal = {
      open: vi.fn(() => container.appendChild(helper)),
      dispose: vi.fn(),
    };

    const renderer = await createTerminalV2OwnedXtermRenderer({
      container,
      cwd: "/repo",
      fontSize: 12,
      TerminalCtor: createTerminalCtor(terminal).constructorMock,
      loadAddons: createLoadAddonsMock().loadAddons,
    });

    expect(renderer.helperTextarea).toBe(helper);
  });

  it("disposes addons and xterm safely once", async () => {
    const terminal = { open: vi.fn(), dispose: vi.fn() };
    const { addons, loadAddons } = createLoadAddonsMock();
    const renderer = await createTerminalV2OwnedXtermRenderer({
      container: document.createElement("div"),
      cwd: "/repo",
      fontSize: 12,
      TerminalCtor: createTerminalCtor(terminal).constructorMock,
      loadAddons,
    });

    renderer.dispose();
    renderer.dispose();

    expect(addons.dispose).toHaveBeenCalledOnce();
    expect(terminal.dispose).toHaveBeenCalledOnce();
  });
});

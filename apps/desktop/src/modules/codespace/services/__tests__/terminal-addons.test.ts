import type { Terminal } from "@xterm/xterm";
import { describe, it, expect, vi, beforeEach } from "vitest";

const openExternalLinkMock = vi.fn();
const openPathInEditorMock = vi.fn();

vi.mock("@/lib/tauri-api", () => ({
  openExternalLink: openExternalLinkMock,
  openPathInEditor: openPathInEditorMock,
}));

// Mock all xterm addon modules using class syntax for constructors
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class { fit = vi.fn(); dispose = vi.fn(); },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    dispose = vi.fn();
    handler?: (event: MouseEvent, uri: string) => void | Promise<void>;
    options?: Record<string, unknown>;

    constructor(handler?: (event: MouseEvent, uri: string) => void | Promise<void>, options?: Record<string, unknown>) {
      this.handler = handler;
      this.options = options;
    }
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class { dispose = vi.fn(); onContextLoss = vi.fn(); },
}));

vi.mock("@xterm/addon-unicode11", () => ({
  Unicode11Addon: class { dispose = vi.fn(); },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class {
    findNext = vi.fn();
    findPrevious = vi.fn();
    clearDecorations = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock("@xterm/addon-clipboard", () => ({
  ClipboardAddon: class { dispose = vi.fn(); },
}));

function createMockTerminal() {
  const contextListeners: Record<string, EventListener | undefined> = {};
  const lines = new Map<number, string>();

  return {
    loadAddon: vi.fn(),
    registerLinkProvider: vi.fn(() => ({ dispose: vi.fn() })),
    unicode: { activeVersion: "6" },
    buffer: {
      active: {
        getLine: (index: number) => {
          const text = lines.get(index);
          return text === undefined
            ? undefined
            : { translateToString: () => text };
        },
      },
    },
    __setLine: (index: number, text: string) => { lines.set(index, text); },
    __contextListeners: contextListeners,
    hasSelection: () => false,
    element: {
      classList: { toggle: vi.fn() },
      addEventListener: vi.fn((type: string, listener: EventListener) => { contextListeners[type] = listener; }),
      removeEventListener: vi.fn((type: string) => { delete contextListeners[type]; }),
    },
  };
}

type MockWebLinksAddon = {
  handler?: (event: MouseEvent, uri: string) => void | Promise<void>;
  options?: Record<string, unknown>;
};

type MockTerminalLink = {
  activate?(event: MouseEvent, uri: string): void | Promise<void>;
  hover?(event: MouseEvent, uri: string): void;
};

type MockTerminalLinkProvider = {
  provideLinks(line: number, callback: (links: MockTerminalLink[] | undefined) => void): void;
};

function asTerminal(term: ReturnType<typeof createMockTerminal>): Terminal {
  return term as unknown as Terminal;
}

function asMockWebLinksAddon(addon: unknown): MockWebLinksAddon {
  return addon as MockWebLinksAddon;
}

function firstLinkProvider(term: ReturnType<typeof createMockTerminal>): MockTerminalLinkProvider {
  const calls = term.registerLinkProvider.mock.calls as unknown as Array<[MockTerminalLinkProvider]>;
  const provider = calls[0]?.[0];
  expect(provider).toBeDefined();
  return provider;
}

describe("loadTerminalAddons", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openExternalLinkMock.mockResolvedValue(undefined);
    openPathInEditorMock.mockResolvedValue(undefined);
  });

  it("returns all non-WebGL addons on happy path", async () => {
    const { loadTerminalAddons } = await import("../terminal-addons");
    const term = createMockTerminal();

    const addons = await loadTerminalAddons(asTerminal(term));

    expect(addons.fitAddon).not.toBeNull();
    expect(addons.webLinksAddon).not.toBeNull();
    // WebGL is intentionally activated later, after first fit(), so its GPU
    // buffer is allocated against valid terminal dimensions.
    expect(addons.webglAddon).toBeNull();
    expect(addons.unicode11Addon).not.toBeNull();
    expect(addons.searchAddon).not.toBeNull();
    expect(addons.clipboardAddon).not.toBeNull();
    expect(term.loadAddon).toHaveBeenCalledTimes(5);
  });

  it("does not load WebGL during loadTerminalAddons even if the module is unavailable", async () => {
    // Make WebGL throw on construction
    const webglMod = await import("@xterm/addon-webgl");
    vi.spyOn(webglMod, "WebglAddon", "get").mockReturnValue(
      class { constructor() { throw new Error("WebGL2 not supported"); } } as unknown as typeof webglMod.WebglAddon
    );

    // Re-import to pick up the mock change
    vi.resetModules();
    // Re-apply the other mocks after resetModules
    vi.doMock("@xterm/addon-fit", () => ({
      FitAddon: class { fit = vi.fn(); dispose = vi.fn(); },
    }));
    vi.doMock("@xterm/addon-web-links", () => ({
      WebLinksAddon: class {
        dispose = vi.fn();
        handler?: (event: MouseEvent, uri: string) => void | Promise<void>;
        options?: Record<string, unknown>;

        constructor(handler?: (event: MouseEvent, uri: string) => void | Promise<void>, options?: Record<string, unknown>) {
          this.handler = handler;
          this.options = options;
        }
      },
    }));
    vi.doMock("@xterm/addon-webgl", () => ({
      WebglAddon: class { constructor() { throw new Error("WebGL2 not supported"); } },
    }));
    vi.doMock("@xterm/addon-unicode11", () => ({
      Unicode11Addon: class { dispose = vi.fn(); },
    }));
    vi.doMock("@xterm/addon-search", () => ({
      SearchAddon: class { findNext = vi.fn(); findPrevious = vi.fn(); clearDecorations = vi.fn(); dispose = vi.fn(); },
    }));
    vi.doMock("@xterm/addon-clipboard", () => ({
      ClipboardAddon: class { dispose = vi.fn(); },
    }));
    vi.doMock("@/lib/tauri-api", () => ({
      openExternalLink: openExternalLinkMock,
      openPathInEditor: openPathInEditorMock,
    }));

    const { loadTerminalAddons } = await import("../terminal-addons");
    const term = createMockTerminal();
    const addons = await loadTerminalAddons(asTerminal(term));

    expect(addons.webglAddon).toBeNull();
    expect(addons.fitAddon).not.toBeNull();
    expect(addons.unicode11Addon).not.toBeNull();
    expect(addons.searchAddon).not.toBeNull();
    expect(addons.clipboardAddon).not.toBeNull();
  });

  it("sets unicode activeVersion to 11 when unicode11 loads", async () => {
    const { loadTerminalAddons } = await import("../terminal-addons");
    const term = createMockTerminal();

    await loadTerminalAddons(asTerminal(term));

    expect(term.unicode.activeVersion).toBe("11");
  });

  it("dispose() calls dispose on all loaded addons", async () => {
    const { loadTerminalAddons } = await import("../terminal-addons");
    const term = createMockTerminal();

    const addons = await loadTerminalAddons(asTerminal(term));
    addons.dispose();

    expect(addons.fitAddon.dispose).toHaveBeenCalled();
    expect(addons.webLinksAddon.dispose).toHaveBeenCalled();
    // WebGL may be null if onContextLoss mock is missing — that's fine
    if (addons.webglAddon) expect(addons.webglAddon.dispose).toHaveBeenCalled();
    if (addons.unicode11Addon) expect(addons.unicode11Addon.dispose).toHaveBeenCalled();
    if (addons.searchAddon) expect(addons.searchAddon.dispose).toHaveBeenCalled();
    if (addons.clipboardAddon) expect(addons.clipboardAddon.dispose).toHaveBeenCalled();
  });

  it("bails out early when isDisposed returns true", async () => {
    const { loadTerminalAddons } = await import("../terminal-addons");
    const term = createMockTerminal();

    const addons = await loadTerminalAddons(asTerminal(term), () => true);

    // Only required addons loaded (fit + web-links), optional ones are null
    expect(addons.fitAddon).not.toBeNull();
    expect(addons.webLinksAddon).not.toBeNull();
    expect(addons.webglAddon).toBeNull();
    expect(addons.unicode11Addon).toBeNull();
    expect(addons.searchAddon).toBeNull();
    expect(addons.clipboardAddon).toBeNull();
  });

  it("configures web links addon with a custom opener and hover callbacks", async () => {
    const { loadTerminalAddons } = await import("../terminal-addons");
    const term = createMockTerminal();

    const addons = await loadTerminalAddons(asTerminal(term));

    const webLinksAddon = asMockWebLinksAddon(addons.webLinksAddon);
    expect(webLinksAddon.handler).toEqual(expect.any(Function));
    expect(webLinksAddon.options).toMatchObject({
      urlRegex: expect.any(RegExp),
      hover: expect.any(Function),
      leave: expect.any(Function),
    });
  });

  it("opens validated terminal links with the external opener bridge", async () => {
    const { loadTerminalAddons } = await import("../terminal-addons");
    const term = createMockTerminal();

    const addons = await loadTerminalAddons(asTerminal(term));
    const preventDefault = vi.fn();

    await asMockWebLinksAddon(addons.webLinksAddon).handler?.({ preventDefault, button: 0, detail: 1 } as unknown as MouseEvent, "https://example.com/docs");

    expect(preventDefault).toHaveBeenCalled();
    expect(openExternalLinkMock).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("ignores unsupported terminal links", async () => {
    const { loadTerminalAddons } = await import("../terminal-addons");
    const term = createMockTerminal();

    const addons = await loadTerminalAddons(asTerminal(term));

    await asMockWebLinksAddon(addons.webLinksAddon).handler?.(new MouseEvent("mouseup", { detail: 1 }), "javascript:alert(1)");

    expect(openExternalLinkMock).not.toHaveBeenCalled();
  });

  it("registers a custom terminal link provider for localhost and file paths", async () => {
    const { loadTerminalAddons } = await import("../terminal-addons");
    const term = createMockTerminal();

    await loadTerminalAddons(asTerminal(term), undefined, { cwd: "/workspace/project" });

    expect(term.registerLinkProvider).toHaveBeenCalledTimes(1);
  });

  it("opens localhost links through the external opener", async () => {
    const { loadTerminalAddons } = await import("../terminal-addons");
    const term = createMockTerminal();
    term.__setLine(0, "Local: localhost:3000");

    await loadTerminalAddons(asTerminal(term), undefined, { cwd: "/workspace/project" });

    const provider = firstLinkProvider(term);
    const links = await new Promise<MockTerminalLink[] | undefined>((resolve) => provider.provideLinks(1, resolve));
    await links?.[0]?.activate?.(new MouseEvent("mouseup", { detail: 1 }), "localhost:3000");

    expect(openExternalLinkMock).toHaveBeenCalledWith("http://localhost:3000/");
  });

  it("opens file path references through the local path bridge", async () => {
    const { loadTerminalAddons } = await import("../terminal-addons");
    const term = createMockTerminal();
    term.__setLine(0, "at src/lib/terminal-addons.ts:60:12");

    await loadTerminalAddons(asTerminal(term), undefined, { cwd: "/workspace/project" });

    const provider = firstLinkProvider(term);
    const links = await new Promise<MockTerminalLink[] | undefined>((resolve) => provider.provideLinks(1, resolve));
    await links?.[0]?.activate?.(new MouseEvent("mouseup", { detail: 1 }), "src/lib/terminal-addons.ts:60:12");

    expect(openPathInEditorMock).toHaveBeenCalledWith("src/lib/terminal-addons.ts", "/workspace/project", 60, 12);
  });

  it("does not open a link on right-click release or while text is selected", async () => {
    const { loadTerminalAddons } = await import("../terminal-addons");
    const term = createMockTerminal();
    term.__setLine(0, "at src/lib/terminal-addons.ts:60:12");
    let selected = false;
    term.hasSelection = () => selected;

    await loadTerminalAddons(asTerminal(term), undefined, { cwd: "/workspace/project" });

    const provider = firstLinkProvider(term);
    const links = await new Promise<MockTerminalLink[] | undefined>((resolve) => provider.provideLinks(1, resolve));
    await links?.[0]?.activate?.(new MouseEvent("mouseup", { button: 2, detail: 1 }), "src/lib/terminal-addons.ts:60:12");
    selected = true;
    await links?.[0]?.activate?.(new MouseEvent("mouseup", { detail: 1 }), "src/lib/terminal-addons.ts:60:12");

    expect(openPathInEditorMock).not.toHaveBeenCalled();
  });

  it("emits a context menu callback for the hovered terminal link", async () => {
    const { loadTerminalAddons } = await import("../terminal-addons");
    const term = createMockTerminal();
    const onLinkContextMenu = vi.fn();
    term.__setLine(0, "at src/lib/terminal-addons.ts:60:12");

    await loadTerminalAddons(asTerminal(term), undefined, {
      cwd: "/workspace/project",
      onLinkContextMenu,
    });

    const provider = firstLinkProvider(term);
    const links = await new Promise<MockTerminalLink[] | undefined>((resolve) => provider.provideLinks(1, resolve));
    links?.[0]?.hover?.({ clientX: 10, clientY: 20 } as MouseEvent, "src/lib/terminal-addons.ts:60:12");

    const preventDefault = vi.fn();
    term.__contextListeners.contextmenu?.({ preventDefault, clientX: 10, clientY: 20 } as unknown as Event);

    expect(preventDefault).toHaveBeenCalled();
    expect(onLinkContextMenu).toHaveBeenCalledWith(expect.objectContaining({
      clientX: 10,
      clientY: 20,
      link: expect.objectContaining({
        text: "src/lib/terminal-addons.ts:60:12",
      }),
    }));
  });
});

describe("activateWebglRenderer — stale terminal guard", () => {
  /**
   * React StrictMode (Next's dev default) mounts, unmounts, then remounts every terminal node.
   * activateWebglRenderer awaits `import("@xterm/addon-webgl")`, so the import can resolve AFTER
   * cleanup already ran `term.dispose()`. Loading the addon onto a disposed terminal throws:
   * WebglAddon builds a LinkRenderLayer from `term._core.linkifier`, and xterm 6's
   * MutableDisposable returns `undefined` from `.value` once disposed
   * (`get value(){ return this._isDisposed ? void 0 : this._value }`), so the addon dereferences
   * `undefined.onShowLinkUnderline`.
   *
   * The old code caught that and logged "WebGL2 not available, using canvas renderer", which
   * pointed every reader at a GPU/driver problem that did not exist.
   */
  beforeEach(() => {
    vi.clearAllMocks();
    // "force" bypasses the capability + backoff checks so activation genuinely runs and the
    // staleness guard is the only thing that can stop it. Without this the tests would pass for the
    // wrong reason: policy would skip activation and every case would return null.
    window.localStorage.setItem("lotus.terminal.webgl.policy", "force");
    // An earlier test in this file vi.doMock()s the WebGL addon to throw on construction, and a
    // doMock persists for every later dynamic import. Restore a working addon so a null result
    // here means the staleness guard fired — not that construction blew up.
    vi.resetModules();
    vi.doMock("@xterm/addon-webgl", () => ({
      WebglAddon: class { dispose = vi.fn(); onContextLoss = vi.fn(); },
    }));
  });

  function ctx(extra: Record<string, unknown> = {}) {
    return { activePaneEligible: true, ...extra };
  }

  it("does not load the addon when the terminal went stale during the import", async () => {
    const { activateWebglRenderer } = await import("../terminal-addons");
    const term = createMockTerminal();

    const addon = await activateWebglRenderer(asTerminal(term), ctx({ isStale: () => true }));

    expect(addon).toBeNull();
    expect(term.loadAddon).not.toHaveBeenCalled();
  });

  it("stays silent on a stale terminal — it is a lifecycle race, not a GPU failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { activateWebglRenderer } = await import("../terminal-addons");
    const term = createMockTerminal();

    await activateWebglRenderer(asTerminal(term), ctx({ isStale: () => true }));

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still loads the addon when the terminal is alive", async () => {
    const { activateWebglRenderer } = await import("../terminal-addons");
    const term = createMockTerminal();

    const addon = await activateWebglRenderer(asTerminal(term), ctx({ isStale: () => false }));

    expect(addon).not.toBeNull();
    expect(term.loadAddon).toHaveBeenCalledTimes(1);
  });

  it("treats a missing isStale predicate as alive, so existing callers are unaffected", async () => {
    const { activateWebglRenderer } = await import("../terminal-addons");
    const term = createMockTerminal();

    const addon = await activateWebglRenderer(asTerminal(term), ctx());

    expect(addon).not.toBeNull();
    expect(term.loadAddon).toHaveBeenCalledTimes(1);
  });

  it("checks staleness AFTER the await, not only before it", async () => {
    // The whole point: the terminal is alive when the call starts and dead by the time the
    // dynamic import resolves. A pre-await-only check would sail straight into loadAddon.
    const { activateWebglRenderer } = await import("../terminal-addons");
    const term = createMockTerminal();
    let alive = true;
    const promise = activateWebglRenderer(asTerminal(term), ctx({ isStale: () => !alive }));
    alive = false;

    expect(await promise).toBeNull();
    expect(term.loadAddon).not.toHaveBeenCalled();
  });

  it("still reports a genuine addon failure as a WebGL problem", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { activateWebglRenderer } = await import("../terminal-addons");
    const term = createMockTerminal();
    term.loadAddon.mockImplementationOnce(() => {
      throw new Error("WebGL2 context creation failed");
    });

    const addon = await activateWebglRenderer(asTerminal(term), ctx({ isStale: () => false }));

    expect(addon).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("WebGL2"),
      expect.any(Error),
    );
    warn.mockRestore();
  });
});

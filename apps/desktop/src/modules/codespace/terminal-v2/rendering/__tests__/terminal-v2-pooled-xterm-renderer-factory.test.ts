import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_V2_POOLED_CUSTOM_KEY_EVENT,
  TERMINAL_V2_POOLED_LINK_CONTEXT_MENU_EVENT,
  createTerminalV2ConstructorPooledXtermRendererFactory,
  createTerminalV2DefaultPooledXtermOptions,
  createTerminalV2PooledXtermRendererFactory,
  type TerminalV2PooledXtermAcceleration,
  type TerminalV2PooledXtermAccelerator,
  type TerminalV2PooledXtermLike,
  type TerminalV2PooledXtermSearchAddonLike,
} from "../terminal-v2-pooled-xterm-renderer-factory";

/** A terminal that reports its Unicode width tables, the way a real xterm does. */
function createUnicodeAwareTerminalMock() {
  return Object.assign(createTerminalMock(), { unicode: { activeVersion: "6" } });
}

function deferredAccelerator(): {
  accelerate: TerminalV2PooledXtermAccelerator;
  calls: TerminalV2PooledXtermAcceleratorCall[];
} {
  const calls: TerminalV2PooledXtermAcceleratorCall[] = [];
  const accelerate: TerminalV2PooledXtermAccelerator = (terminal, context) => {
    let resolve!: (activation: TerminalV2PooledXtermAcceleration | null) => void;
    const promise = new Promise<TerminalV2PooledXtermAcceleration | null>((r) => {
      resolve = r;
    });
    calls.push({ terminal, context, resolve });
    return promise;
  };
  return { accelerate, calls };
}

type TerminalV2PooledXtermAcceleratorCall = {
  terminal: TerminalV2PooledXtermLike;
  context: Parameters<TerminalV2PooledXtermAccelerator>[1];
  resolve(activation: TerminalV2PooledXtermAcceleration | null): void;
};

function createTerminalMock() {
  type LinkProvider = Parameters<NonNullable<TerminalV2PooledXtermLike["registerLinkProvider"]>>[0];
  return {
    reset: vi.fn(),
    write: vi.fn(),
    refresh: vi.fn(),
    rows: 24,
    buffer: {
      active: {
        getLine: vi.fn(() => ({ translateToString: (): string => "" })),
      },
    },
    open: vi.fn(),
    loadAddon: vi.fn(),
    onRender: vi.fn<(listener: () => void) => { dispose(): void }>(),
    attachCustomKeyEventHandler: vi.fn<(handler: (event: KeyboardEvent) => boolean) => void>(),
    registerLinkProvider: vi.fn((provider: LinkProvider) => {
      void provider;
      return { dispose: vi.fn() };
    }),
    dispose: vi.fn(),
  };
}

function createFitAddonMock() {
  return {
    fit: vi.fn(),
    dispose: vi.fn(),
  };
}

function createSerializeAddonMock() {
  return {
    serialize: vi.fn(() => "serialized-buffer"),
    dispose: vi.fn(),
  };
}

function createSearchAddonMock() {
  return {
    findNext: vi.fn<TerminalV2PooledXtermSearchAddonLike["findNext"]>(() => true),
    findPrevious: vi.fn<TerminalV2PooledXtermSearchAddonLike["findPrevious"]>(() => false),
    clearDecorations: vi.fn(),
    dispose: vi.fn(),
  };
}

function createClipboardAddonMock() {
  return {
    dispose: vi.fn(),
  };
}

describe("createTerminalV2PooledXtermRendererFactory", () => {
  it("provides CodeSpace terminal visual defaults for pooled xterm renderers", () => {
    document.documentElement.style.setProperty("--cs-terminal-bg", "#101820");

    expect(createTerminalV2DefaultPooledXtermOptions()).toEqual(expect.objectContaining({
      fontSize: 11,
      lineHeight: 1,
      letterSpacing: 0,
      customGlyphs: true,
      cursorStyle: "bar",
      cursorInactiveStyle: "outline",
      allowProposedApi: true,
      rescaleOverlappingGlyphs: false,
      scrollback: 5000,
      theme: expect.objectContaining({
        background: "#101820",
        foreground: "#e8e8f0",
        cursor: "#7c3aed",
      }),
    }));
  });

  it("creates an xterm renderer inside the pooled slot element", () => {
    const terminal = createTerminalMock();
    const fitAddon = createFitAddonMock();
    const slotElement = document.createElement("div");
    const factory = createTerminalV2PooledXtermRendererFactory({
      createTerminal: vi.fn(() => terminal),
      createFitAddon: vi.fn(() => fitAddon),
    });

    const renderer = factory(slotElement, "renderer-1");

    expect(terminal.loadAddon).toHaveBeenCalledWith(fitAddon);
    expect(terminal.open).toHaveBeenCalledWith(slotElement);
    expect(renderer.terminal).toBe(terminal);
    expect(renderer.fitAddon).toBe(fitAddon);
  });

  it("disposes xterm and fit addon exactly once", () => {
    const terminal = createTerminalMock();
    const fitAddon = createFitAddonMock();
    const factory = createTerminalV2PooledXtermRendererFactory({
      createTerminal: () => terminal,
      createFitAddon: () => fitAddon,
    });

    const renderer = factory(document.createElement("div"), "renderer-1");
    renderer.dispose();
    renderer.dispose();

    expect(fitAddon.dispose).toHaveBeenCalledTimes(1);
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
  });

  it("cleans up created resources when opening the terminal fails", () => {
    const terminal = createTerminalMock();
    const fitAddon = createFitAddonMock();
    const openError = new Error("open failed");
    terminal.open.mockImplementation(() => { throw openError; });
    const factory = createTerminalV2PooledXtermRendererFactory({
      createTerminal: () => terminal,
      createFitAddon: () => fitAddon,
    });

    expect(() => factory(document.createElement("div"), "renderer-1")).toThrow(openError);
    expect(fitAddon.dispose).toHaveBeenCalledTimes(1);
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
  });

  it("exposes the xterm helper textarea from the pooled slot element", () => {
    const terminal = createTerminalMock();
    terminal.open.mockImplementation((slotElement: HTMLElement) => {
      const textarea = document.createElement("textarea");
      textarea.className = "xterm-helper-textarea";
      slotElement.appendChild(textarea);
    });
    const slotElement = document.createElement("div");
    const factory = createTerminalV2PooledXtermRendererFactory({
      createTerminal: () => terminal,
      createFitAddon: () => createFitAddonMock(),
    });

    const renderer = factory(slotElement, "renderer-1");

    expect(renderer.helperTextarea).toBe(slotElement.querySelector("textarea.xterm-helper-textarea"));
  });

  it("exposes xterm render events for pooled health checks", () => {
    const terminal = createTerminalMock();
    const disposable = { dispose: vi.fn() };
    terminal.onRender.mockReturnValue(disposable);
    const factory = createTerminalV2PooledXtermRendererFactory({
      createTerminal: () => terminal,
      createFitAddon: () => createFitAddonMock(),
    });
    const listener = vi.fn();

    const renderer = factory(document.createElement("div"), "renderer-1");
    const result = renderer.onRender?.(listener);

    expect(terminal.onRender).toHaveBeenCalledWith(listener);
    expect(result).toBe(disposable);
  });

  it("exposes search through an optional search addon", () => {
    const terminal = createTerminalMock();
    const searchAddon = createSearchAddonMock();
    const factory = createTerminalV2PooledXtermRendererFactory({
      createTerminal: () => terminal,
      createFitAddon: () => createFitAddonMock(),
      createSearchAddon: () => searchAddon,
    });

    const renderer = factory(document.createElement("div"), "renderer-1");

    expect(terminal.loadAddon).toHaveBeenCalledWith(searchAddon);
    expect(renderer.search?.findNext("kebon", "live")).toBe(true);
    expect(renderer.search?.findPrevious("alpha")).toBe(false);
    renderer.search?.clearSearch();
    expect(searchAddon.findNext.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ incremental: true }));
    expect(searchAddon.findPrevious.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ decorations: expect.any(Object) }));
    expect(searchAddon.clearDecorations).toHaveBeenCalledOnce();
    renderer.dispose();
    expect(searchAddon.dispose).toHaveBeenCalledOnce();
  });

  it("dispatches pooled custom-key events and returns the pane handler result", () => {
    const terminal = createTerminalMock();
    const slotElement = document.createElement("div");
    const factory = createTerminalV2PooledXtermRendererFactory({
      createTerminal: () => terminal,
      createFitAddon: () => createFitAddonMock(),
    });
    slotElement.addEventListener(TERMINAL_V2_POOLED_CUSTOM_KEY_EVENT, (event) => {
      (event as CustomEvent<{ result?: boolean }>).detail.result = false;
    });

    factory(slotElement, "renderer-1");
    const handler = terminal.attachCustomKeyEventHandler.mock.calls[0]?.[0];
    const keyEvent = new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true });

    expect(handler(keyEvent)).toBe(false);
  });

  it("dispatches pooled link context-menu events from detected terminal links", () => {
    const terminal = createTerminalMock();
    terminal.buffer.active.getLine.mockReturnValue({
      translateToString: () => "open src/app/page.tsx:12",
    });
    const slotElement = document.createElement("div");
    const received: Event[] = [];
    slotElement.addEventListener(TERMINAL_V2_POOLED_LINK_CONTEXT_MENU_EVENT, (event) => received.push(event));
    const factory = createTerminalV2PooledXtermRendererFactory({
      createTerminal: () => terminal,
      createFitAddon: () => createFitAddonMock(),
    });

    factory(slotElement, "renderer-1");
    const provider = terminal.registerLinkProvider.mock.calls[0]?.[0];
    expect(provider).toBeDefined();
    let links: Array<{ hover?: () => void }> | undefined;
    provider!.provideLinks(1, (nextLinks) => {
      links = nextLinks as typeof links;
    });
    links?.[0]?.hover?.();
    slotElement.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 50, clientY: 60 }));

    const detail = (received[0] as CustomEvent | undefined)?.detail;
    expect(detail).toEqual(expect.objectContaining({
      clientX: 50,
      clientY: 60,
      trigger: "contextmenu",
      link: expect.objectContaining({
        kind: "path",
        text: "src/app/page.tsx:12",
        path: "src/app/page.tsx",
        line: 12,
      }),
    }));
  });

  it("tags a left-click (activate) with trigger 'activate' so the consumer opens it directly", () => {
    const terminal = createTerminalMock();
    terminal.buffer.active.getLine.mockReturnValue({
      translateToString: () => "see https://example.com now",
    });
    const slotElement = document.createElement("div");
    const received: Event[] = [];
    slotElement.addEventListener(TERMINAL_V2_POOLED_LINK_CONTEXT_MENU_EVENT, (event) => received.push(event));
    const factory = createTerminalV2PooledXtermRendererFactory({
      createTerminal: () => terminal,
      createFitAddon: () => createFitAddonMock(),
    });

    factory(slotElement, "renderer-1");
    const provider = terminal.registerLinkProvider.mock.calls[0]?.[0];
    let links: Array<{ activate?: (e: MouseEvent) => void }> | undefined;
    provider!.provideLinks(1, (nextLinks) => {
      links = nextLinks as typeof links;
    });
    links?.[0]?.activate?.(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 20 }));

    const detail = (received[0] as CustomEvent | undefined)?.detail;
    expect(detail).toEqual(expect.objectContaining({
      trigger: "activate",
      link: expect.objectContaining({ kind: "external", text: "https://example.com" }),
    }));
  });

  it("loads and disposes an optional clipboard addon", () => {
    const terminal = createTerminalMock();
    const clipboardAddon = createClipboardAddonMock();
    const factory = createTerminalV2PooledXtermRendererFactory({
      createTerminal: () => terminal,
      createFitAddon: () => createFitAddonMock(),
      createClipboardAddon: () => clipboardAddon,
    });

    const renderer = factory(document.createElement("div"), "renderer-1");

    expect(terminal.loadAddon).toHaveBeenCalledWith(clipboardAddon);
    renderer.dispose();
    expect(clipboardAddon.dispose).toHaveBeenCalledOnce();
  });

  it("captures snapshots through an optional serialize addon", () => {
    const terminal = createTerminalMock();
    const fitAddon = createFitAddonMock();
    const serializeAddon = createSerializeAddonMock();
    const factory = createTerminalV2PooledXtermRendererFactory({
      createTerminal: () => terminal,
      createFitAddon: () => fitAddon,
      createSerializeAddon: () => serializeAddon,
    });

    const renderer = factory(document.createElement("div"), "renderer-1");

    expect(renderer.captureSnapshot?.()).toBe("serialized-buffer");
    expect(terminal.loadAddon).toHaveBeenCalledWith(serializeAddon);
    renderer.dispose();
    expect(serializeAddon.dispose).toHaveBeenCalledTimes(1);
  });

  it("registers the Unicode 11 width tables AND selects them", () => {
    // Loading the addon alone leaves activeVersion at 6, where an emoji measures one cell while
    // the font paints two — the status line then eats the character after every emoji.
    const terminal = createUnicodeAwareTerminalMock();
    const unicode11Addon = { dispose: vi.fn() };
    const factory = createTerminalV2PooledXtermRendererFactory({
      createTerminal: () => terminal,
      createFitAddon: () => createFitAddonMock(),
      createUnicode11Addon: () => unicode11Addon,
    });

    factory(document.createElement("div"), "renderer-1");

    expect(terminal.loadAddon).toHaveBeenCalledWith(unicode11Addon);
    expect(terminal.unicode.activeVersion).toBe("11");
  });

  it("leaves the width tables alone when no unicode addon is supplied", () => {
    const terminal = createUnicodeAwareTerminalMock();
    const factory = createTerminalV2PooledXtermRendererFactory({
      createTerminal: () => terminal,
      createFitAddon: () => createFitAddonMock(),
    });

    factory(document.createElement("div"), "renderer-1");

    expect(terminal.unicode.activeVersion).toBe("6");
  });

  it("promotes an attached slot once and hands the renderer back when it parks", async () => {
    const activation = { dispose: vi.fn() };
    const accelerate = vi.fn<TerminalV2PooledXtermAccelerator>(async () => activation);
    const factory = createTerminalV2PooledXtermRendererFactory({
      createTerminal: () => createTerminalMock(),
      createFitAddon: () => createFitAddonMock(),
      accelerate,
    });
    const renderer = factory(document.createElement("div"), "renderer-1");

    renderer.setVisible?.(true);
    await vi.waitFor(() => expect(accelerate).toHaveBeenCalledTimes(1));
    renderer.setVisible?.(true);
    expect(accelerate).toHaveBeenCalledTimes(1);

    renderer.setVisible?.(false);
    expect(activation.dispose).toHaveBeenCalledTimes(1);
  });

  it("never promotes a slot that was never attached", () => {
    const accelerate = vi.fn<TerminalV2PooledXtermAccelerator>(async () => ({ dispose: vi.fn() }));
    const factory = createTerminalV2PooledXtermRendererFactory({
      createTerminal: () => createTerminalMock(),
      createFitAddon: () => createFitAddonMock(),
      accelerate,
    });

    factory(document.createElement("div"), "renderer-1");

    expect(accelerate).not.toHaveBeenCalled();
  });

  it("throws away an activation that arrives after the slot parked", async () => {
    // The addon import is async, so the slot can be parked — or disposed — while it is in flight.
    // Keeping that activation would leave a GPU context bound to a terminal nobody can see.
    const { accelerate, calls } = deferredAccelerator();
    const factory = createTerminalV2PooledXtermRendererFactory({
      createTerminal: () => createTerminalMock(),
      createFitAddon: () => createFitAddonMock(),
      accelerate,
    });
    const renderer = factory(document.createElement("div"), "renderer-1");

    renderer.setVisible?.(true);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    renderer.setVisible?.(false);
    expect(calls[0]?.context.isStale()).toBe(true);

    const activation = { dispose: vi.fn() };
    calls[0]?.resolve(activation);
    await vi.waitFor(() => expect(activation.dispose).toHaveBeenCalledTimes(1));
  });

  it("lets a later attach retry after the GPU context was lost", async () => {
    const first = { dispose: vi.fn() };
    const second = { dispose: vi.fn() };
    const results = [first, second];
    const accelerate = vi.fn<TerminalV2PooledXtermAccelerator>(async () => results.shift() ?? null);
    const factory = createTerminalV2PooledXtermRendererFactory({
      createTerminal: () => createTerminalMock(),
      createFitAddon: () => createFitAddonMock(),
      accelerate,
    });
    const renderer = factory(document.createElement("div"), "renderer-1");

    renderer.setVisible?.(true);
    await vi.waitFor(() => expect(accelerate).toHaveBeenCalledTimes(1));
    // The addon disposes itself before reporting the loss; the renderer only drops its reference.
    accelerate.mock.calls[0]?.[1].onLost();

    renderer.setVisible?.(false);
    renderer.setVisible?.(true);
    await vi.waitFor(() => expect(accelerate).toHaveBeenCalledTimes(2));
    expect(first.dispose).not.toHaveBeenCalled();
  });

  it("releases the accelerated renderer when the pooled renderer is disposed", async () => {
    const activation = { dispose: vi.fn() };
    const accelerate = vi.fn<TerminalV2PooledXtermAccelerator>(async () => activation);
    const terminal = createTerminalMock();
    const factory = createTerminalV2PooledXtermRendererFactory({
      createTerminal: () => terminal,
      createFitAddon: () => createFitAddonMock(),
      accelerate,
    });
    const renderer = factory(document.createElement("div"), "renderer-1");

    renderer.setVisible?.(true);
    await vi.waitFor(() => expect(accelerate).toHaveBeenCalledTimes(1));
    renderer.dispose();

    expect(activation.dispose).toHaveBeenCalledTimes(1);
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
  });

  it("creates a concrete constructor-backed xterm renderer factory", () => {
    const terminalCtorSpy = vi.fn();
    const fitAddonCtorSpy = vi.fn();
    class TerminalCtor {
      rows = 24;
      reset = vi.fn();
      write = vi.fn();
      refresh = vi.fn();
      open = vi.fn();
      loadAddon = vi.fn();
      dispose = vi.fn();

      constructor(options?: Record<string, unknown>) {
        terminalCtorSpy(options);
      }
    }
    class FitAddonCtor {
      fit = vi.fn();
      dispose = vi.fn();

      constructor() {
        fitAddonCtorSpy();
      }
    }
    class SearchAddonCtor {
      findNext = vi.fn(() => true);
      findPrevious = vi.fn(() => false);
      clearDecorations = vi.fn();
      dispose = vi.fn();
    }
    class ClipboardAddonCtor {
      dispose = vi.fn();
    }
    const factory = createTerminalV2ConstructorPooledXtermRendererFactory({
      TerminalCtor,
      FitAddonCtor,
      SearchAddonCtor,
      ClipboardAddonCtor,
      terminalOptions: { fontSize: 13 },
    });

    const renderer = factory(document.createElement("div"), "renderer-1");

    expect(terminalCtorSpy).toHaveBeenCalledWith({ fontSize: 13 });
    expect(fitAddonCtorSpy).toHaveBeenCalledWith();
    expect(renderer.terminal).toBeInstanceOf(TerminalCtor);
    expect(renderer.fitAddon).toBeInstanceOf(FitAddonCtor);
    expect(renderer.search?.findNext("needle")).toBe(true);
    expect((renderer.terminal as InstanceType<typeof TerminalCtor>).loadAddon)
      .toHaveBeenCalledWith(expect.any(ClipboardAddonCtor));
  });
});

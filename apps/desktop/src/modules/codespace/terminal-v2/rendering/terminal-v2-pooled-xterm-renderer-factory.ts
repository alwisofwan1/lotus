import { terminalOscLinkHandler } from "@/lib/terminal-web-links";
import type { TerminalTheme } from "@/lib/design-system";
import { detectMonoFontFamily } from "@/lib/fonts";
import { resolveCodeSpaceTerminalRenderMetrics } from "@/modules/codespace/services/codespace-terminal-render-theme";
import type { TerminalLinkContextMenuPayload } from "@/modules/codespace/services/terminal-addons";
import {
  createTerminalLinkClickGuard,
  detectTerminalLinksInLine,
  type TerminalDetectedLink,
} from "@/modules/codespace/services/terminal-links";
import {
  createTerminalSearchOptions,
  hasVisibleTerminalSearchSelection,
  repaintTerminalSearchSelection,
  selectTerminalSearchFallbackMatch,
  type TerminalSearchFallbackTerminal,
} from "@/modules/codespace/services/terminal-search-options";
import {
  createTerminalV2PooledRendererAcceleration,
  type TerminalV2PooledXtermAccelerator,
} from "./terminal-v2-pooled-renderer-acceleration";
import type { TerminalV2PooledRenderer } from "./terminal-v2-pooled-dom-slot";
import type {
  TerminalV2FitAddonLike,
  TerminalV2XtermLike,
} from "./terminal-v2-xterm-renderer-host";

export const TERMINAL_V2_POOLED_CUSTOM_KEY_EVENT = "terminal-v2-pooled-custom-key";
export const TERMINAL_V2_POOLED_LINK_CONTEXT_MENU_EVENT = "terminal-v2-pooled-link-context-menu";

export type TerminalV2PooledCustomKeyDetail = {
  event: KeyboardEvent;
  result?: boolean;
};

export type TerminalV2PooledXtermLike = TerminalV2XtermLike & {
  buffer?: { active?: { getLine?(index: number): { translateToString(trimRight?: boolean): string } | undefined } };
  /** Live options on a real xterm: assigning `theme` or `fontSize` repaints the existing buffer. */
  options?: Record<string, unknown>;
  /** Present on a real xterm; the width tables the Unicode 11 addon replaces live behind it. */
  unicode?: { activeVersion: string };
  open(element: HTMLElement): void;
  loadAddon?(addon: unknown): void;
  onData?(listener: (data: string) => void): { dispose(): void };
  onRender?(listener: () => void): { dispose(): void };
  attachCustomKeyEventHandler?(handler: (event: KeyboardEvent) => boolean): void;
  hasSelection?(): boolean;
  registerLinkProvider?(provider: {
    provideLinks(bufferLineNumber: number, callback: (links: unknown[] | undefined) => void): void;
  }): { dispose(): void };
  dispose(): void;
};

export type TerminalV2PooledXtermFitAddonLike = TerminalV2FitAddonLike & {
  dispose?(): void;
};

export type TerminalV2PooledXtermSerializeAddonLike = {
  serialize(): string;
  dispose?(): void;
};

export type TerminalV2PooledXtermSearchAddonLike = {
  findNext(query: string, options?: ReturnType<typeof createTerminalSearchOptions>): boolean;
  findPrevious(query: string, options?: ReturnType<typeof createTerminalSearchOptions>): boolean;
  clearDecorations(): void;
  dispose?(): void;
};

export type TerminalV2PooledXtermClipboardAddonLike = {
  dispose?(): void;
};

export type TerminalV2PooledXtermUnicode11AddonLike = {
  dispose?(): void;
};

export type {
  TerminalV2PooledXtermAcceleration,
  TerminalV2PooledXtermAccelerator,
  TerminalV2PooledXtermAcceleratorContext,
} from "./terminal-v2-pooled-renderer-acceleration";

export type TerminalV2PooledXtermRendererFactoryOptions = {
  createTerminal(slotId: string): TerminalV2PooledXtermLike;
  createFitAddon(slotId: string): TerminalV2PooledXtermFitAddonLike;
  createSerializeAddon?(slotId: string): TerminalV2PooledXtermSerializeAddonLike;
  createSearchAddon?(slotId: string): TerminalV2PooledXtermSearchAddonLike;
  createClipboardAddon?(slotId: string): TerminalV2PooledXtermClipboardAddonLike;
  createUnicode11Addon?(slotId: string): TerminalV2PooledXtermUnicode11AddonLike;
  /** Injected so a test can assert the promote/demote protocol without a GPU. */
  accelerate?: TerminalV2PooledXtermAccelerator;
};

export type TerminalV2PooledXtermConstructor = new (options?: Record<string, unknown>) => TerminalV2PooledXtermLike;
export type TerminalV2PooledXtermFitAddonConstructor = new () => TerminalV2PooledXtermFitAddonLike;
export type TerminalV2PooledXtermSerializeAddonConstructor = new () => TerminalV2PooledXtermSerializeAddonLike;
export type TerminalV2PooledXtermSearchAddonConstructor = new () => TerminalV2PooledXtermSearchAddonLike;
export type TerminalV2PooledXtermClipboardAddonConstructor = new () => TerminalV2PooledXtermClipboardAddonLike;
export type TerminalV2PooledXtermUnicode11AddonConstructor = new () => TerminalV2PooledXtermUnicode11AddonLike;

export type TerminalV2ConstructorPooledXtermRendererFactoryOptions = {
  terminalOptions?: Record<string, unknown>;
  TerminalCtor: TerminalV2PooledXtermConstructor;
  FitAddonCtor: TerminalV2PooledXtermFitAddonConstructor;
  SerializeAddonCtor?: TerminalV2PooledXtermSerializeAddonConstructor;
  SearchAddonCtor?: TerminalV2PooledXtermSearchAddonConstructor;
  ClipboardAddonCtor?: TerminalV2PooledXtermClipboardAddonConstructor;
  Unicode11AddonCtor?: TerminalV2PooledXtermUnicode11AddonConstructor;
  accelerate?: TerminalV2PooledXtermAccelerator;
};

export type TerminalV2PooledXtermRendererFactory = (
  slotElement: HTMLElement,
  slotId: string,
) => TerminalV2PooledRenderer;

function installPooledCustomKeyHandler(
  terminal: TerminalV2PooledXtermLike,
  slotElement: HTMLElement,
): void {
  terminal.attachCustomKeyEventHandler?.((event) => {
    const detail: TerminalV2PooledCustomKeyDetail = { event };
    slotElement.dispatchEvent(new CustomEvent(TERMINAL_V2_POOLED_CUSTOM_KEY_EVENT, {
      bubbles: true,
      detail,
    }));
    return detail.result ?? true;
  });
}

function dispatchPooledLinkContextMenu(
  slotElement: HTMLElement,
  payload: TerminalLinkContextMenuPayload,
): void {
  slotElement.dispatchEvent(new CustomEvent(TERMINAL_V2_POOLED_LINK_CONTEXT_MENU_EVENT, {
    bubbles: true,
    detail: payload,
  }));
}

function installPooledTerminalLinks(
  terminal: TerminalV2PooledXtermLike,
  slotElement: HTMLElement,
): () => void {
  let hoveredLink: TerminalDetectedLink | null = null;
  const clickGuard = createTerminalLinkClickGuard(slotElement, () => terminal.hasSelection?.() ?? false);
  const linkProvider = terminal.registerLinkProvider?.({
    provideLinks(bufferLineNumber, callback) {
      const lineText = terminal.buffer?.active?.getLine?.(bufferLineNumber - 1)?.translateToString(true) ?? "";
      const links = detectTerminalLinksInLine(lineText).map((link) => ({
        range: {
          start: { x: link.start + 1, y: bufferLineNumber },
          end: { x: link.end, y: bufferLineNumber },
        },
        text: link.text,
        decorations: { pointerCursor: true, underline: true },
        activate: (event: MouseEvent) => {
          if (!clickGuard.allows(event)) return;
          event.preventDefault();
          // Left-click opens the link directly (consumer routes by trigger); right-click shows the menu.
          dispatchPooledLinkContextMenu(slotElement, {
            clientX: event.clientX,
            clientY: event.clientY,
            link,
            trigger: "activate",
          });
        },
        hover: () => {
          hoveredLink = link;
        },
        leave: () => {
          if (hoveredLink === link) hoveredLink = null;
        },
      }));
      callback(links.length > 0 ? links : undefined);
    },
  });

  const onContextMenu = (event: Event) => {
    if (!hoveredLink) return;
    const mouseEvent = event as MouseEvent;
    mouseEvent.preventDefault();
    dispatchPooledLinkContextMenu(slotElement, {
      clientX: mouseEvent.clientX,
      clientY: mouseEvent.clientY,
      link: hoveredLink,
      trigger: "contextmenu",
    });
  };
  slotElement.addEventListener("contextmenu", onContextMenu);

  return () => {
    slotElement.removeEventListener("contextmenu", onContextMenu);
    clickGuard.dispose();
    linkProvider?.dispose();
  };
}

function createPooledSearchApi(
  searchAddon: TerminalV2PooledXtermSearchAddonLike,
  terminal: TerminalSearchFallbackTerminal,
): NonNullable<TerminalV2PooledRenderer["search"]> {
  return {
    findNext: (query, mode = "navigate") => {
      const matched = searchAddon.findNext(query, createTerminalSearchOptions(mode));
      if (hasVisibleTerminalSearchSelection(terminal, query)) {
        repaintTerminalSearchSelection(terminal, query);
        return matched;
      }
      return selectTerminalSearchFallbackMatch({
        direction: "next",
        includeCurrentSelection: mode === "live",
        query,
        terminal,
      }) || matched;
    },
    findPrevious: (query) => {
      const matched = searchAddon.findPrevious(query, createTerminalSearchOptions("navigate"));
      if (hasVisibleTerminalSearchSelection(terminal, query)) {
        repaintTerminalSearchSelection(terminal, query);
        return matched;
      }
      return selectTerminalSearchFallbackMatch({ direction: "previous", query, terminal }) || matched;
    },
    clearSearch: () => {
      searchAddon.clearDecorations();
      terminal.clearSelection?.();
    },
  };
}

function resolveDefaultPooledTerminalTheme(): TerminalTheme {
  const cssBg = typeof document !== "undefined"
    ? (getComputedStyle(document.documentElement).getPropertyValue("--cs-terminal-bg").trim() || "#060609")
    : "#060609";

  return {
    background: cssBg,
    foreground: "#e8e8f0",
    cursor: "#7c3aed",
    cursorAccent: cssBg,
    selectionBackground: "rgba(124, 58, 237, 0.3)",
    black: "#1a1a28",
    brightBlack: "#3a3a4a",
    red: "#f87171",
    brightRed: "#fca5a5",
    green: "#34d399",
    brightGreen: "#6ee7b7",
    yellow: "#fbbf24",
    brightYellow: "#fcd34d",
    blue: "#60a5fa",
    brightBlue: "#93c5fd",
    magenta: "#c084fc",
    brightMagenta: "#d8b4fe",
    cyan: "#22d3ee",
    brightCyan: "#67e8f9",
    white: "#e8e8f0",
    brightWhite: "#f8f8ff",
  };
}

export function createTerminalV2DefaultPooledXtermOptions(
  fontSize = 11,
  terminalTheme?: TerminalTheme,
): Record<string, unknown> {
  const renderMetrics = resolveCodeSpaceTerminalRenderMetrics();
  return {
    fontFamily: detectMonoFontFamily(),
    fontSize,
    lineHeight: renderMetrics.lineHeight,
    letterSpacing: renderMetrics.letterSpacing,
    fontWeight: renderMetrics.fontWeight,
    fontWeightBold: renderMetrics.fontWeightBold,
    theme: terminalTheme ?? resolveDefaultPooledTerminalTheme(),
    customGlyphs: true,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorInactiveStyle: "outline",
    allowProposedApi: true,
    linkHandler: terminalOscLinkHandler,
    allowTransparency: false,
    rescaleOverlappingGlyphs: false,
    scrollback: 5000,
  };
}

export function createTerminalV2ConstructorPooledXtermRendererFactory({
  terminalOptions,
  TerminalCtor,
  FitAddonCtor,
  SerializeAddonCtor,
  SearchAddonCtor,
  ClipboardAddonCtor,
  Unicode11AddonCtor,
  accelerate,
}: TerminalV2ConstructorPooledXtermRendererFactoryOptions): TerminalV2PooledXtermRendererFactory {
  return createTerminalV2PooledXtermRendererFactory({
    createTerminal: () => new TerminalCtor(terminalOptions),
    createFitAddon: () => new FitAddonCtor(),
    createSerializeAddon: SerializeAddonCtor ? () => new SerializeAddonCtor() : undefined,
    createSearchAddon: SearchAddonCtor ? () => new SearchAddonCtor() : undefined,
    createClipboardAddon: ClipboardAddonCtor ? () => new ClipboardAddonCtor() : undefined,
    createUnicode11Addon: Unicode11AddonCtor ? () => new Unicode11AddonCtor() : undefined,
    accelerate,
  });
}

export function createTerminalV2PooledXtermRendererFactory({
  createTerminal,
  createFitAddon,
  createSerializeAddon,
  createSearchAddon,
  createClipboardAddon,
  createUnicode11Addon,
  // Left undefined here on purpose: the acceleration controller owns the default, so there is one
  // place that decides what "accelerated" means.
  accelerate,
}: TerminalV2PooledXtermRendererFactoryOptions): TerminalV2PooledXtermRendererFactory {
  return (slotElement, slotId) => {
    const terminal = createTerminal(slotId);
    const fitAddon = createFitAddon(slotId);
    const serializeAddon = createSerializeAddon?.(slotId) ?? null;
    const searchAddon = createSearchAddon?.(slotId) ?? null;
    const clipboardAddon = createClipboardAddon?.(slotId) ?? null;
    const unicode11Addon = createUnicode11Addon?.(slotId) ?? null;
    const cleanupLinks = installPooledTerminalLinks(terminal, slotElement);
    installPooledCustomKeyHandler(terminal, slotElement);
    const acceleration = createTerminalV2PooledRendererAcceleration({ terminal, accelerate });
    let disposed = false;

    const disposeOnce = () => {
      if (disposed) return;
      disposed = true;
      acceleration.dispose();
      cleanupLinks();
      clipboardAddon?.dispose?.();
      searchAddon?.dispose?.();
      serializeAddon?.dispose?.();
      fitAddon.dispose?.();
      terminal.dispose();
    };

    try {
      terminal.loadAddon?.(fitAddon);
      if (serializeAddon) terminal.loadAddon?.(serializeAddon);
      if (searchAddon) terminal.loadAddon?.(searchAddon);
      if (clipboardAddon) terminal.loadAddon?.(clipboardAddon);
      if (unicode11Addon) {
        terminal.loadAddon?.(unicode11Addon);
        // Loading the addon REGISTERS the Unicode 11 width tables; it does not select them.
        // Without this line an emoji stays one cell wide, its glyph is drawn two cells wide, and
        // it eats the character after it — "📁~/workspace" arrives as "📁/workspace".
        if (terminal.unicode) terminal.unicode.activeVersion = "11";
      }
      terminal.open(slotElement);
    } catch (error) {
      disposeOnce();
      throw error;
    }

    const renderer: TerminalV2PooledRenderer = {
      terminal,
      fitAddon,
      dispose: disposeOnce,
      helperTextarea: slotElement.querySelector<HTMLTextAreaElement>("textarea.xterm-helper-textarea"),
    };

    if (serializeAddon) {
      renderer.captureSnapshot = () => serializeAddon.serialize();
    }
    if (terminal.onData) {
      renderer.onData = (listener) => terminal.onData?.(listener) ?? { dispose() {} };
    }
    if (terminal.onRender) {
      renderer.onRender = (listener) => terminal.onRender?.(listener) ?? { dispose() {} };
    }
    if (searchAddon) {
      renderer.search = createPooledSearchApi(searchAddon, terminal as TerminalSearchFallbackTerminal);
    }

    renderer.setVisible = (visible) => acceleration.setVisible(visible);
    renderer.setAppearance = ({ theme, fontSize }) => {
      if (!terminal.options) return;
      if (theme) terminal.options.theme = theme;
      if (fontSize !== undefined) terminal.options.fontSize = fontSize;
    };

    return renderer;
  };
}

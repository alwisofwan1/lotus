import { terminalOscLinkHandler } from "@/lib/terminal-web-links";
import type { TerminalTheme } from "@/lib/design-system";
import { detectMonoFontFamily } from "@/lib/fonts";
import {
  loadTerminalAddons,
  type TerminalAddons,
  type TerminalAddonOptions,
  type TerminalLinkContextMenuPayload,
} from "@/modules/codespace/services/terminal-addons";
import { resolveCodeSpaceTerminalRenderMetrics } from "@/modules/codespace/services/codespace-terminal-render-theme";

export type TerminalV2OwnedXtermTerminal = {
  open(container: HTMLElement): void;
  dispose(): void;
};

export type TerminalV2OwnedXtermConstructor = new (options: Record<string, unknown>) => TerminalV2OwnedXtermTerminal;

export type TerminalV2OwnedXtermRenderer = {
  terminal: TerminalV2OwnedXtermTerminal;
  addons: TerminalAddons;
  helperTextarea: HTMLTextAreaElement | null;
  dispose(): void;
};

export type CreateTerminalV2OwnedXtermRendererOptions = {
  container: HTMLElement;
  cwd: string;
  fontSize: number;
  terminalTheme?: TerminalTheme;
  allowTransparency?: boolean;
  isDisposed?: () => boolean;
  onLinkContextMenu?: (payload: TerminalLinkContextMenuPayload) => void;
  TerminalCtor?: TerminalV2OwnedXtermConstructor;
  loadAddons?: (
    terminal: TerminalV2OwnedXtermTerminal,
    isDisposed?: () => boolean,
    options?: TerminalAddonOptions,
  ) => Promise<TerminalAddons>;
};

const TERMINAL_V2_FONT_READY_TIMEOUT_MS = 750;

async function waitForTerminalV2Fonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  try {
    await Promise.race([
      document.fonts.ready,
      new Promise<void>((resolve) => setTimeout(resolve, TERMINAL_V2_FONT_READY_TIMEOUT_MS)),
    ]);
  } catch {
    // Best effort: xterm can still render with the fallback stack.
  }
}

function resolveDefaultTerminalTheme(theme?: TerminalTheme): TerminalTheme {
  if (theme) return theme;

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

async function resolveTerminalCtor(injected?: TerminalV2OwnedXtermConstructor): Promise<TerminalV2OwnedXtermConstructor> {
  if (injected) return injected;
  const { Terminal } = await import("@xterm/xterm");
  return Terminal as TerminalV2OwnedXtermConstructor;
}

export async function createTerminalV2OwnedXtermRenderer({
  container,
  cwd,
  fontSize,
  terminalTheme,
  allowTransparency = false,
  isDisposed,
  onLinkContextMenu,
  TerminalCtor,
  loadAddons,
}: CreateTerminalV2OwnedXtermRendererOptions): Promise<TerminalV2OwnedXtermRenderer> {
  await waitForTerminalV2Fonts();
  const ResolvedTerminal = await resolveTerminalCtor(TerminalCtor);
  const renderMetrics = resolveCodeSpaceTerminalRenderMetrics();
  const terminal = new ResolvedTerminal({
    theme: resolveDefaultTerminalTheme(terminalTheme),
    fontFamily: detectMonoFontFamily(),
    fontSize,
    lineHeight: renderMetrics.lineHeight,
    letterSpacing: renderMetrics.letterSpacing,
    fontWeight: renderMetrics.fontWeight,
    fontWeightBold: renderMetrics.fontWeightBold,
    customGlyphs: true,
    cursorBlink: true,
    cursorStyle: "bar",
    cursorInactiveStyle: "outline",
    allowProposedApi: true,
    linkHandler: terminalOscLinkHandler,
    allowTransparency,
    rescaleOverlappingGlyphs: false,
    scrollback: 5000,
  });

  terminal.open(container);
  const loadRendererAddons = loadAddons ?? (loadTerminalAddons as NonNullable<CreateTerminalV2OwnedXtermRendererOptions["loadAddons"]>);
  const addons = await loadRendererAddons(terminal, isDisposed, { cwd, onLinkContextMenu });
  let disposed = false;

  return {
    terminal,
    addons,
    helperTextarea: container.querySelector("textarea.xterm-helper-textarea"),
    dispose() {
      if (disposed) return;
      disposed = true;
      addons.dispose();
      terminal.dispose();
    },
  };
}

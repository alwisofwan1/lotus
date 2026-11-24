import { describe, expect, it, vi } from "vitest";

const loadedAddons: unknown[] = [];
const terminalOptions: Array<Record<string, unknown> | undefined> = [];

vi.mock("@xterm/xterm", () => ({
  Terminal: class TerminalMock {
    rows = 24;
    reset = vi.fn();
    write = vi.fn();
    refresh = vi.fn();
    open = vi.fn();
    loadAddon = vi.fn((addon: unknown) => loadedAddons.push(addon));
    dispose = vi.fn();

    constructor(options?: Record<string, unknown>) {
      terminalOptions.push(options);
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class FitAddonMock {
    fit = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class SerializeAddonMock {
    serialize = vi.fn(() => "snapshot");
    dispose = vi.fn();
  },
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: class SearchAddonMock {
    findNext = vi.fn(() => false);
    findPrevious = vi.fn(() => false);
    clearDecorations = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock("@xterm/addon-clipboard", () => ({
  ClipboardAddon: class ClipboardAddonMock {
    dispose = vi.fn();
  },
}));

describe("loadDefaultPooledXtermRendererFactory", () => {
  it("loads clipboard support into default pooled xterm renderers", async () => {
    loadedAddons.length = 0;
    terminalOptions.length = 0;
    const { loadDefaultPooledXtermRendererFactory } = await import("../terminal-v2-pooled-renderer-loader");

    const factory = await loadDefaultPooledXtermRendererFactory();
    factory(document.createElement("div"), "renderer-1");

    expect(loadedAddons.some((addon) => addon?.constructor?.name === "ClipboardAddonMock")).toBe(true);
  });

  it("passes the active terminal theme to pooled xterm options", async () => {
    loadedAddons.length = 0;
    terminalOptions.length = 0;
    const terminalTheme = {
      background: "#111111",
      foreground: "#eeeeee",
      cursor: "#abcdef",
      cursorAccent: "#111111",
      selectionBackground: "rgba(255,255,255,0.2)",
      black: "#000000",
      brightBlack: "#333333",
      red: "#ff0000",
      brightRed: "#ff6666",
      green: "#00ff00",
      brightGreen: "#66ff66",
      yellow: "#ffff00",
      brightYellow: "#ffff66",
      blue: "#0000ff",
      brightBlue: "#6666ff",
      magenta: "#ff00ff",
      brightMagenta: "#ff66ff",
      cyan: "#00ffff",
      brightCyan: "#66ffff",
      white: "#dddddd",
      brightWhite: "#ffffff",
    };
    const { loadDefaultPooledXtermRendererFactory } = await import("../terminal-v2-pooled-renderer-loader");

    const factory = await loadDefaultPooledXtermRendererFactory({ terminalTheme });
    factory(document.createElement("div"), "renderer-1");

    expect(terminalOptions[0]).toEqual(expect.objectContaining({ theme: terminalTheme }));
  });

  it("passes the requested terminal font size to pooled xterm options", async () => {
    loadedAddons.length = 0;
    terminalOptions.length = 0;
    const { loadDefaultPooledXtermRendererFactory } = await import("../terminal-v2-pooled-renderer-loader");

    const factory = await loadDefaultPooledXtermRendererFactory({ fontSize: 15 });
    factory(document.createElement("div"), "renderer-1");

    expect(terminalOptions[0]).toEqual(expect.objectContaining({ fontSize: 15 }));
  });
});

import fs from "fs";
import path from "path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Frame, Keyboard, Palette, Terminal, Volume2 } from "lucide-react";

import {
  LAST_SECTION_STORAGE_KEY,
  LotusSettingsProvider,
  useLotusSettings,
  useLotusSettingsHost,
  type LotusSettingsHost,
} from "../../lotus-settings-context";
import type { SettingsSectionEntry } from "../../settings-sections";

class LocalStorageMock {
  private store: Record<string, string> = {};
  getItem(key: string) { return this.store[key] ?? null; }
  setItem(key: string, value: string) { this.store[key] = String(value); }
  removeItem(key: string) { delete this.store[key]; }
  clear() { this.store = {}; }
}

beforeEach(() => {
  vi.stubGlobal("localStorage", new LocalStorageMock());
});

// Light stand-ins for the real sections, so the frame is tested without every section's Tauri
// traffic. The sidebar is one flat list in this order.
const section = (group: SettingsSectionEntry["group"], id: string, title: string, icon = Volume2): SettingsSectionEntry => ({
  group, id, title, icon, render: () => <p>{title} body</p>,
});
const SECTIONS: SettingsSectionEntry[] = [
  section("lotus", "voice", "Voice"),
  section("lotus", "hotkeys", "Hotkeys", Keyboard),
  section("canvas", "canvas-style", "Canvas Style", Palette),
  section("canvas", "canvas", "Canvas", Frame),
  section("code", "codespace", "CodeSpace", Terminal),
  section("chat", "codechat", "CodeChat", Terminal),
];

function Opener({ host }: { host?: LotusSettingsHost }) {
  const { openSettings } = useLotusSettings();
  useLotusSettingsHost(host ?? null);
  return (
    <>
      <button type="button" onClick={() => openSettings({ from: "canvas-gear" })}>canvas gear</button>
      <textarea aria-label="terminal" onKeyDown={(e) => e.stopPropagation()} />
    </>
  );
}

function renderSettings(props: { host?: LotusSettingsHost; sections?: SettingsSectionEntry[] } = {}) {
  return render(
    <LotusSettingsProvider sections={props.sections ?? SECTIONS}>
      <Opener host={props.host} />
    </LotusSettingsProvider>,
  );
}

const pressSettingsChord = (target: Element | Window = window) => fireEvent.keyDown(target, { key: ",", metaKey: true });
const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}$`) });

describe("Lotus Settings", () => {
  it("keeps modal panes shrinkable so overflowing settings content scrolls inside the dialog", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src/styles/canvas/settings-modal.css"), "utf8");

    expect(css).toMatch(/\.canvas-settings-surface\s*\{[\s\S]*?height:\s*min\(84dvh, 640px\);[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/);
    expect(css).toMatch(/\.canvas-settings-content\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/);
    expect(css).toMatch(/\.canvas-settings-content-body\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/);
    expect(css).toMatch(/\.canvas-settings-rail\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/);
  });

  it("is closed until asked for", () => {
    renderSettings();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens on ⌘, as Lotus · Settings, with one flat sidebar in registry order", () => {
    renderSettings();
    pressSettingsChord();

    const dialog = screen.getByRole("dialog", { name: "Lotus settings" });
    expect(within(dialog).getByText("Lotus · Settings")).toBeInTheDocument();
    const nav = within(dialog).getByRole("navigation");
    expect(within(nav).queryAllByRole("group")).toEqual([]);
    expect(within(nav).getAllByRole("tab").map((t) => t.textContent)).toEqual(SECTIONS.map((s) => s.title));
  });

  it("opens on ⌘, even while a terminal that swallows its keys has focus", () => {
    renderSettings();
    pressSettingsChord(screen.getByLabelText("terminal"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("takes focus from the terminal while open, so keys stop reaching it, and gives it back on close", () => {
    renderSettings();
    const terminal = screen.getByLabelText("terminal");
    terminal.focus();
    pressSettingsChord(terminal);

    expect(tab("Voice")).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(terminal).toHaveFocus();
  });

  it("opens the canvas gear on Canvas › Canvas Style", () => {
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "canvas gear" }));

    expect(tab("Canvas Style")).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Canvas Style" })).toBeInTheDocument();
    expect(screen.getByText("Canvas Style body")).toBeInTheDocument();
  });

  it("starts ⌘, on the first section of the mode on screen", () => {
    renderSettings({ host: { mode: "canvas" } });
    pressSettingsChord();
    expect(tab("Canvas Style")).toHaveAttribute("aria-selected", "true");
  });

  it("opens on ⌘, from Code and Chat, starting in that mode's group", () => {
    const { unmount } = renderSettings({ host: { mode: "code" } });
    pressSettingsChord();
    expect(tab("CodeSpace")).toHaveAttribute("aria-selected", "true");
    unmount();
    localStorage.clear();

    renderSettings({ host: { mode: "chat" } });
    pressSettingsChord();
    expect(tab("CodeChat")).toHaveAttribute("aria-selected", "true");
  });

  it("reopens ⌘, on the section last viewed, across reloads", () => {
    const { unmount } = renderSettings();
    pressSettingsChord();
    fireEvent.click(tab("Hotkeys"));
    expect(screen.getByText("Hotkeys body")).toBeInTheDocument();
    pressSettingsChord();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    unmount();

    renderSettings();
    pressSettingsChord();
    expect(tab("Hotkeys")).toHaveAttribute("aria-selected", "true");
    expect(localStorage.getItem(LAST_SECTION_STORAGE_KEY)).toBe("hotkeys");
  });

  it("moves through the sidebar with the arrow keys", () => {
    renderSettings();
    pressSettingsChord();
    tab("Voice").focus();

    fireEvent.keyDown(tab("Voice"), { key: "ArrowDown" });
    expect(tab("Hotkeys")).toHaveAttribute("aria-selected", "true");
    expect(tab("Hotkeys")).toHaveFocus();

    fireEvent.keyDown(tab("Hotkeys"), { key: "ArrowDown" });
    expect(tab("Canvas Style")).toHaveFocus();

    fireEvent.keyDown(tab("Canvas Style"), { key: "ArrowUp" });
    expect(tab("Hotkeys")).toHaveFocus();

    fireEvent.keyDown(tab("Hotkeys"), { key: "End" });
    expect(tab("CodeChat")).toHaveFocus();
    fireEvent.keyDown(tab("CodeChat"), { key: "Home" });
    expect(tab("Voice")).toHaveFocus();
  });

  it("closes on Escape, the close button and the backdrop — but not on surface clicks", () => {
    renderSettings();
    pressSettingsChord();
    fireEvent.pointerDown(screen.getByRole("dialog"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    pressSettingsChord();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    pressSettingsChord();
    fireEvent.pointerDown(screen.getByRole("dialog").parentElement!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("maximises and restores", () => {
    renderSettings();
    pressSettingsChord();
    fireEvent.click(screen.getByRole("button", { name: "Maximize window" }));
    expect(screen.getByRole("dialog")).toHaveAttribute("data-maximized", "true");
    fireEvent.click(screen.getByRole("button", { name: "Restore window" }));
    expect(screen.getByRole("dialog")).not.toHaveAttribute("data-maximized");
  });

  it("paints with the Canvas Style the canvas registers, and with the app theme otherwise", () => {
    const { unmount } = renderSettings({
      host: { mode: "canvas", themeStyle: { ["--ct-canvas-accent" as string]: "#123456" }, themeAttributes: { "data-canvas-mode": "light" } },
    });
    pressSettingsChord();
    const scope = screen.getByRole("dialog").closest(".lotus-settings-scope") as HTMLElement;
    expect(scope.style.getPropertyValue("--ct-canvas-accent")).toBe("#123456");
    expect(scope).toHaveAttribute("data-canvas-mode", "light");
    unmount();

    renderSettings({ host: { mode: "code" } });
    pressSettingsChord();
    const plain = screen.getByRole("dialog").closest(".lotus-settings-scope") as HTMLElement;
    expect(plain.style.getPropertyValue("--ct-canvas-accent")).toBe("");
    expect(plain).not.toHaveAttribute("data-canvas-mode");
  });

  it("hosts the real sections: Hotkeys renders its own panel", async () => {
    render(<LotusSettingsProvider><span /></LotusSettingsProvider>);
    pressSettingsChord();
    fireEvent.click(tab("Hotkeys"));
    expect(await screen.findByText("Command palette")).toBeInTheDocument();
  });
});

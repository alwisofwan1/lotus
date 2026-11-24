import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  file: {} as Record<string, unknown>,
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
  isTauri: () => false,
  getSettings: tauri.getSettings,
  saveSettings: tauri.saveSettings,
  getEditorAvailability: vi.fn().mockResolvedValue({ vscode: false, cursor: false, antigravity: false, antigravityApp: false }),
}));
vi.mock("@/lib/tauri/runtime", () => ({ isTauri: () => false }));
vi.mock("@/lib/tauri/agent-cli", () => ({
  getAgentCliAvailability: vi.fn().mockResolvedValue({ available: false, resolvedPath: null, source: null }),
  discoverAgentCliModels: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { LotusSettingsProvider, useLotusSettings } from "../lotus-settings-context";
import { SETTINGS_SAVE_DEBOUNCE_MS } from "../hooks/useSettingsFile";
import type { SettingsEntryPoint } from "../services/open-request";

class LocalStorageMock {
  private store: Record<string, string> = {};
  getItem(key: string) { return this.store[key] ?? null; }
  setItem(key: string, value: string) { this.store[key] = String(value); }
  removeItem(key: string) { delete this.store[key]; }
  clear() { this.store = {}; }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal("localStorage", new LocalStorageMock());
  tauri.file = { editorPreference: "cursor", hooks: { Stop: [] } };
  tauri.getSettings.mockReset().mockImplementation(async () => structuredClone(tauri.file));
  tauri.saveSettings.mockReset().mockImplementation(async (next: Record<string, unknown>) => { tauri.file = next; });
});

afterEach(() => {
  vi.useRealTimers();
});

function Gear({ from }: { from: SettingsEntryPoint }) {
  const { openSettings } = useLotusSettings();
  return <button type="button" onClick={() => openSettings({ from })}>gear</button>;
}

async function openFrom(from: SettingsEntryPoint, ready: string) {
  render(<LotusSettingsProvider><Gear from={from} /></LotusSettingsProvider>);
  fireEvent.click(screen.getByRole("button", { name: "gear" }));
  await screen.findByText(ready);
  return screen.getByRole("dialog");
}

const settle = () => act(() => vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS));

describe("Lotus Settings › Code and Chat groups", () => {
  it("opens the Code rail gear on Code › CodeSpace, which saves a terminal font change on its own", async () => {
    const dialog = await openFrom("code-rail", "Terminal font size");
    expect(within(dialog).getByRole("tab", { name: /^CodeSpace$/ })).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).queryByRole("button", { name: /^save/i })).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByRole("combobox", { name: /terminal font size/i }), { target: { value: "16" } });
    await settle();

    expect(tauri.saveSettings).toHaveBeenCalledTimes(1);
    expect(tauri.saveSettings).toHaveBeenCalledWith({ editorPreference: "cursor", hooks: { Stop: [] }, "terminal-font-size": 16 });
  });

  it("writes only what a control changed, never a stale copy of the file", async () => {
    const dialog = await openFrom("code-rail", "Terminal font size");
    tauri.file = { ...tauri.file, editorPreference: "vscode" }; // saved elsewhere after the section loaded

    fireEvent.click(within(dialog).getByRole("switch", { name: /toggle automatic pane titles/i }));
    await settle();

    expect(tauri.file).toEqual({
      editorPreference: "vscode",
      hooks: { Stop: [] },
      codespace: expect.objectContaining({ autoPaneTitles: expect.any(Boolean) }),
    });
  });

  it("opens the Chat rail gear on Chat, which picks the chat font", async () => {
    render(<LotusSettingsProvider><Gear from="chat-rail" /></LotusSettingsProvider>);
    fireEvent.click(screen.getByRole("button", { name: "gear" }));
    // The section is a lazy import; a loaded full-suite run can take over the default 1 s.
    expect(await screen.findByRole("tab", { name: /^Chat$/ }, { timeout: 5000 })).toHaveAttribute("aria-selected", "true");
    // Picking a font saves it and restyles the preview at once.
    const select = await screen.findByRole("combobox", { name: "Chat font" }, { timeout: 5000 });
    // Reading also holds Concise replies, read from settings.json: let it load before the change.
    await screen.findByText("Concise replies");
    fireEvent.change(select, { target: { value: "serif" } });
    expect(localStorage.getItem("lotus.chat.font")).toBe("serif");
    expect(screen.getByTestId("chat-font-preview").style.getPropertyValue("--chat-read-font")).toContain("Source Serif");
  });

  it("Chat's title model defaults to Haiku 5.5 and saves the picked model as chat.titleModel", async () => {
    render(<LotusSettingsProvider><Gear from="chat-rail" /></LotusSettingsProvider>);
    fireEvent.click(screen.getByRole("button", { name: "gear" }));
    const select = await screen.findByRole("combobox", { name: "Conversation title model" }, { timeout: 5000 });
    expect(select).toHaveValue("claude-haiku-5-5");

    fireEvent.change(select, { target: { value: "claude-sonnet-4-6" } });
    await settle();

    expect(tauri.file).toEqual({ editorPreference: "cursor", hooks: { Stop: [] }, chat: { titleModel: "claude-sonnet-4-6" } });
  });
});

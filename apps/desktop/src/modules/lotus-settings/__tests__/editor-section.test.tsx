import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  file: {} as Record<string, unknown>,
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  getEditorAvailability: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => ({
  isTauri: () => true,
  getSettings: tauri.getSettings,
  saveSettings: tauri.saveSettings,
  getEditorAvailability: tauri.getEditorAvailability,
}));

import { LotusSettingsProvider } from "../lotus-settings-context";
import { SETTINGS_SAVE_DEBOUNCE_MS } from "../hooks/useSettingsFile";
import { LOTUS_SETTINGS_CHANGED_EVENT } from "@/modules/settings/services/settings-events";

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
  // What is on disk: the editor plus keys this section does not own, which must survive a save.
  tauri.file = { editorPreference: "system", maxTeammates: 5, hooks: { Stop: [] } };
  tauri.getSettings.mockReset().mockImplementation(async () => structuredClone(tauri.file));
  tauri.saveSettings.mockReset().mockImplementation(async (next: Record<string, unknown>) => { tauri.file = next; });
  tauri.getEditorAvailability.mockReset().mockResolvedValue({ vscode: true, cursor: false, antigravity: false, antigravityApp: false });
});

afterEach(() => {
  vi.useRealTimers();
});

async function openEditor() {
  render(<LotusSettingsProvider><span /></LotusSettingsProvider>);
  fireEvent.keyDown(window, { key: ",", metaKey: true });
  fireEvent.click(screen.getByRole("tab", { name: /^General$/ }));
  return screen.findByRole("combobox", { name: "Editor" });
}

describe("Lotus Settings › General › Editor", () => {
  it("saves a changed editor once, after the debounce, changing only that field", async () => {
    const select = await openEditor();
    fireEvent.change(select, { target: { value: "vscode" } });
    expect(tauri.saveSettings).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS));

    expect(tauri.saveSettings).toHaveBeenCalledTimes(1);
    expect(tauri.saveSettings).toHaveBeenCalledWith({ editorPreference: "vscode", maxTeammates: 5, hooks: { Stop: [] } });
  });

  it("keeps what another writer put in settings.json after the section loaded", async () => {
    const select = await openEditor();
    tauri.file = { ...tauri.file, hooks: { Stop: [{ installedBy: "hook installer" }] } };
    fireEvent.change(select, { target: { value: "vscode" } });
    await act(() => vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS));

    expect(tauri.saveSettings).toHaveBeenCalledWith({
      editorPreference: "vscode", maxTeammates: 5, hooks: { Stop: [{ installedBy: "hook installer" }] },
    });
  });

  it("says Saved and tells the open mode, then keeps the choice when settings is reopened", async () => {
    const heard = vi.fn();
    window.addEventListener(LOTUS_SETTINGS_CHANGED_EVENT, heard);
    const select = await openEditor();
    fireEvent.change(select, { target: { value: "vscode" } });
    await act(() => vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS));

    // General has more than one save status (Editor, Notifications); one of them says Saved.
    expect(screen.getAllByRole("status").some((status) => status.textContent?.includes("Saved"))).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener(LOTUS_SETTINGS_CHANGED_EVENT, heard);

    fireEvent.keyDown(window, { key: ",", metaKey: true });
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(await screen.findByRole("combobox", { name: "Editor" })).toHaveValue("vscode");
  });

  it("shows a clear error when the write fails, and keeps the new choice on screen to retry", async () => {
    tauri.saveSettings.mockRejectedValueOnce("Permission denied (os error 13)");
    const select = await openEditor();
    fireEvent.change(select, { target: { value: "vscode" } });
    await act(() => vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS));

    expect(screen.getByRole("alert")).toHaveTextContent("Not saved: Permission denied (os error 13)");
    expect(select).toHaveValue("vscode");

    fireEvent.change(select, { target: { value: "system" } });
    fireEvent.change(select, { target: { value: "vscode" } });
    await act(() => vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(tauri.file.editorPreference).toBe("vscode");
  });

  it("saves a typed command on blur, not per keystroke", async () => {
    tauri.file = { ...tauri.file, editorPreference: "custom", editorArgs: ["{path}"] };
    await openEditor();
    const command = screen.getByRole("textbox", { name: "Editor command" });
    fireEvent.change(command, { target: { value: "ze" } });
    fireEvent.change(command, { target: { value: "zed" } });
    await act(() => vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS * 2));
    expect(tauri.saveSettings).not.toHaveBeenCalled();

    fireEvent.blur(command);
    await act(() => vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS));
    expect(tauri.saveSettings).toHaveBeenCalledTimes(1);
    expect(tauri.file.editorCommand).toBe("zed");
  });

  it("still saves a change made just before settings is closed", async () => {
    const select = await openEditor();
    fireEvent.change(select, { target: { value: "vscode" } });
    fireEvent.keyDown(window, { key: "Escape" });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(tauri.file.editorPreference).toBe("vscode");
  });

  it("has no Save button, and none of the options that did nothing or appear elsewhere", async () => {
    await openEditor();
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
    for (const gone of [/Max Teammates/i, /Auto Pane Titles/i, /Dark Theme/i, /Light Theme/i]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
  });
});

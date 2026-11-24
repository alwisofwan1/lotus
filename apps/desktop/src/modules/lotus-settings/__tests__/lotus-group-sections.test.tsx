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
  getNlModelConfig: vi.fn().mockResolvedValue(null),
  setNlModelConfig: vi.fn(),
}));
vi.mock("@/lib/tauri/codespace", () => ({
  getAgentHooksHealth: vi.fn().mockResolvedValue({ scripts_installed: true, stop_hook_registered: true, notification_hook_registered: false }),
}));

import { LotusSettingsProvider } from "../lotus-settings-context";
import { SETTINGS_SAVE_DEBOUNCE_MS } from "../hooks/useSettingsFile";

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
  tauri.file = { env: { FOO: "bar" }, teammateMode: "in-process", hooks: { Stop: [] } };
  tauri.getSettings.mockReset().mockImplementation(async () => structuredClone(tauri.file));
  tauri.saveSettings.mockReset().mockImplementation(async (next: Record<string, unknown>) => { tauri.file = next; });
});

afterEach(() => {
  vi.useRealTimers();
});

async function openSection(title: RegExp, ready: string) {
  render(<LotusSettingsProvider><span /></LotusSettingsProvider>);
  fireEvent.keyDown(window, { key: ",", metaKey: true });
  fireEvent.click(screen.getByRole("tab", { name: title }));
  await screen.findByText(ready);
  return screen.getByRole("dialog");
}

const settle = () => act(() => vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS));

describe("Lotus Settings › rest of the Lotus group", () => {
  it("shows Agent Teams in Agents, with no agent catalog and no Display Mode", async () => {
    const dialog = await openSection(/^Agents$/, "CLIs");
    expect(await within(dialog).findByText(/my own claude sessions/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/teams Lotus launches always have it on/i)).toBeInTheDocument();
    expect(await within(dialog).findByText("Notification hook registered")).toBeInTheDocument();
    expect(within(dialog).queryByText(/Display Mode/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Agent catalog/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Split Panes/i)).not.toBeInTheDocument();
  });

  it("saves the agent teams toggle on its own, keeping the other env vars", async () => {
    const dialog = await openSection(/^Agents$/, "CLIs");
    fireEvent.click(await within(dialog).findByRole("switch", { name: /agent teams in my own claude sessions/i }));
    await settle();

    expect(tauri.saveSettings).toHaveBeenCalledTimes(1);
    expect(tauri.file).toEqual({
      env: { FOO: "bar", CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" },
      teammateMode: "in-process",
      hooks: { Stop: [] },
    });
  });

  it("keeps the fleet knobs under Agents › Advanced, and saves one on its own", async () => {
    const dialog = await openSection(/^Agents$/, "CLIs");
    fireEvent.click(await within(dialog).findByRole("switch", { name: "List exited panes in the fleet" }));
    await settle();

    expect(tauri.saveSettings).toHaveBeenCalledTimes(1);
    expect(tauri.file.bridge).toEqual({ orchestration: { includeExitedInFleet: expect.any(Boolean) } });
  });

  it("shows only real paths in About: no dead shortcut, no remote-workspace notes, no JSON dump", async () => {
    const dialog = await openSection(/^About$/, "Settings file");
    expect(within(dialog).getByText("~/.lotus")).toBeInTheDocument();
    expect(within(dialog).queryByText(/Keyboard Shortcuts/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Remote workspaces/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/settings.json preview/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/~\/\.claude\/teams/)).not.toBeInTheDocument();
  });

  it("has Appearance and the editor in General", async () => {
    const dialog = await openSection(/^General$/, "System");
    expect(await within(dialog).findByRole("combobox", { name: "Editor" })).toBeInTheDocument();
  });
});

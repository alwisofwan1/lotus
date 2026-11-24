import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ file: {} as Record<string, unknown>, getSettings: vi.fn(), saveSettings: vi.fn() }));
vi.mock("@/lib/tauri-api", () => ({ getSettings: tauri.getSettings, saveSettings: tauri.saveSettings }));

import { SETTINGS_SAVE_DEBOUNCE_MS, useSettingsFile } from "../useSettingsFile";

// Microtask delays, not timers: a write still in flight when a test ends must not wait on a fake
// clock that is about to be thrown away, or the shared write queue stalls every later test.
const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  tauri.file = { untouched: true };
  // A slow disk: every read and write takes a moment, so two sections' saves overlap.
  tauri.getSettings.mockReset().mockImplementation(async () => { const copy = structuredClone(tauri.file); await tick(); return copy; });
  tauri.saveSettings.mockReset().mockImplementation(async (next: Record<string, unknown>) => { await tick(); tauri.file = next; });
});
afterEach(() => vi.useRealTimers());

describe("useSettingsFile", () => {
  it("keeps both changes when two sections save at the same moment", async () => {
    const a = renderHook(() => useSettingsFile());
    const b = renderHook(() => useSettingsFile());
    await act(() => vi.advanceTimersByTimeAsync(20));

    act(() => { a.result.current.update({ editorPreference: "vscode" }); b.result.current.update({ teammateMode: "auto" }); });
    await act(() => vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS + 100));

    expect(tauri.file).toEqual({ untouched: true, editorPreference: "vscode", teammateMode: "auto" });
  });

  it("writes only the keys that changed when a section hands over the whole object", async () => {
    const { result } = renderHook(() => useSettingsFile());
    await act(() => vi.advanceTimersByTimeAsync(20));
    tauri.file = { untouched: true, editorPreference: "vscode" }; // saved elsewhere after the section loaded

    act(() => result.current.update({ ...result.current.settings, teammateMode: "auto" }));
    await act(() => vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS + 100));

    expect(tauri.file).toEqual({ untouched: true, editorPreference: "vscode", teammateMode: "auto" });
  });

  it("does not let the first read overwrite a change made while it was in flight", async () => {
    const { result } = renderHook(() => useSettingsFile());
    act(() => result.current.update({ editorPreference: "vscode" }));
    await act(() => vi.advanceTimersByTimeAsync(20));

    expect(result.current.settings?.editorPreference).toBe("vscode");
  });

  it("reports Saved for a finished write even while a typed change is still held", async () => {
    const { result } = renderHook(() => useSettingsFile());
    await act(() => vi.advanceTimersByTimeAsync(20));
    // Hold the write's read open, so the user starts typing while it is in flight.
    let release!: () => void;
    tauri.getSettings.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(structuredClone(tauri.file)); }));
    act(() => result.current.update({ editorPreference: "vscode" }));
    await act(() => vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS));
    act(() => result.current.update({ editorCommand: "ze" }, { hold: true }));
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(20); });

    expect(result.current.state).toEqual({ kind: "saved" });
  });

  it("retries a failed write with the next change", async () => {
    tauri.saveSettings.mockRejectedValueOnce("Permission denied");
    const { result } = renderHook(() => useSettingsFile());
    await act(() => vi.advanceTimersByTimeAsync(20));
    act(() => result.current.update({ editorPreference: "vscode" }));
    await act(() => vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS + 50));
    expect(result.current.state.kind).toBe("error");

    act(() => result.current.update({ teammateMode: "auto" }));
    await act(() => vi.advanceTimersByTimeAsync(SETTINGS_SAVE_DEBOUNCE_MS + 50));
    expect(tauri.file).toEqual({ untouched: true, editorPreference: "vscode", teammateMode: "auto" });
  });
});

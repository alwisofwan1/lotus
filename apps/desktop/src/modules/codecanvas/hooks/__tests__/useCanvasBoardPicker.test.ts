import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryCodeCanvasProjectRepository } from "../../services/codecanvas-project-repository";

const apiMocks = vi.hoisted(() => ({
  getHomedir: vi.fn(),
  isTauri: vi.fn(() => true),
}));
vi.mock("@/lib/tauri-api", () => ({
  getHomedir: apiMocks.getHomedir,
  isTauri: apiMocks.isTauri,
}));
vi.mock("@/modules/codespace/services/terminal-session-registry", () => ({
  closeWorkspaceTerminalSessions: vi.fn(),
  closeTerminalSession: vi.fn(),
}));

import { useCanvasBoard } from "../useCanvasBoard";

describe("useCanvasBoard — picker home default", () => {
  beforeEach(() => {
    apiMocks.isTauri.mockReturnValue(true);
    apiMocks.getHomedir.mockReset().mockResolvedValue("/Users/alwi");
  });

  it("prefills the picker with the home directory and a trailing slash", async () => {
    const repository = createInMemoryCodeCanvasProjectRepository();
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.pickerInput).toBe("/Users/alwi/"));
  });

  it("openPicker reopens with the home default after the field was cleared", async () => {
    const repository = createInMemoryCodeCanvasProjectRepository();
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.pickerInput).toBe("/Users/alwi/"));

    act(() => result.current.setPickerInput(""));
    act(() => result.current.openPicker());

    expect(result.current.pickerInput).toBe("/Users/alwi/");
    expect(result.current.showPicker).toBe(true);
  });

  it("does not overwrite a path the user already typed before home resolves", async () => {
    let resolveHome: (path: string) => void = () => {};
    apiMocks.getHomedir.mockReturnValue(new Promise<string>((r) => { resolveHome = r; }));
    const repository = createInMemoryCodeCanvasProjectRepository();
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => result.current.setPickerInput("/tmp/work"));
    await act(async () => { resolveHome("/Users/alwi"); await Promise.resolve(); });

    expect(result.current.pickerInput).toBe("/tmp/work");
  });

  it("skips the home lookup outside Tauri", async () => {
    apiMocks.isTauri.mockReturnValue(false);
    const repository = createInMemoryCodeCanvasProjectRepository();
    const { result } = renderHook(() => useCanvasBoard({ repository }));
    await act(async () => { await Promise.resolve(); });

    expect(apiMocks.getHomedir).not.toHaveBeenCalled();
    expect(result.current.pickerInput).toBe("");
  });
});

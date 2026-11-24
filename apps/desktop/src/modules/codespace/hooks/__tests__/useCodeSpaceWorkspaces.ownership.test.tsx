import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const closeWindowPtySessions = vi.fn<() => Promise<number>>(() => Promise.resolve(0));
const reapOrphanedSessions = vi.fn();

vi.mock("@/lib/tauri-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri-api")>()),
  closeWindowPtySessions: () => closeWindowPtySessions(),
}));

vi.mock("@/lib/pty-session-controller", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pty-session-controller")>()),
  reapOrphanedSessions: () => reapOrphanedSessions(),
}));

vi.mock("@/modules/codespace/services/workspace-metadata", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/codespace/services/workspace-metadata")>()),
  loadPersistedCodeSpaceSnapshot: vi.fn(() => Promise.resolve(null)),
  savePersistedCodeSpaceSnapshot: vi.fn(() => Promise.resolve()),
}));

import {
  resetCodeSpaceWorkspaceOwnershipForTests,
  useCodeSpaceWorkspaces,
} from "@/modules/codespace/hooks/useCodeSpaceWorkspaces";

describe("workspace ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCodeSpaceWorkspaceOwnershipForTests();
  });

  afterEach(() => {
    resetCodeSpaceWorkspaceOwnershipForTests();
  });

  it("reaps the session registry once per window, and never kills this window's PTYs", () => {
    /*
      `close_window_sessions` kills every PTY this window owns, Canvas agents included. Rust runs
      it on page load; from this hook it killed live Canvas agents the first time Code mode
      mounted after a reload into Canvas.
    */
    const first = renderHook(() => useCodeSpaceWorkspaces());
    expect(reapOrphanedSessions).toHaveBeenCalledTimes(1);

    first.unmount();
    renderHook(() => useCodeSpaceWorkspaces());

    expect(reapOrphanedSessions).toHaveBeenCalledTimes(1);
    expect(closeWindowPtySessions).not.toHaveBeenCalled();
  });

  it("says so when a second owner mounts, instead of losing a workspace quietly", () => {
    // Two of these in one window are two writers of one snapshot, and the last save wins. The
    // symptom is a workspace that disappears; the cause is invisible unless it is printed.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    renderHook(() => useCodeSpaceWorkspaces());
    expect(error).not.toHaveBeenCalled();

    renderHook(() => useCodeSpaceWorkspaces());
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("two workspace owners");

    error.mockRestore();
  });

  it("lets ownership pass from one surface to the next without complaining", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const first = renderHook(() => useCodeSpaceWorkspaces());
    first.unmount();
    renderHook(() => useCodeSpaceWorkspaces());

    // A handover is one owner at a time; only an overlap is a bug.
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

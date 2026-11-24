import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handleSnapshot = vi.fn();
const handleMount = vi.fn();
const handleUnmount = vi.fn();
const handleCriticalSnapshot = vi.fn();
const forcePush = vi.fn();

vi.mock("../../services/canvas-fleet-push-scheduler", () => ({
  getCanvasFleetPushScheduler: () => ({
    handleSnapshot,
    handleMount,
    handleUnmount,
    handleCriticalSnapshot,
    forcePush,
  }),
}));

// jsdom is not Tauri, so the pull-on-miss listener is skipped and the effect stays synchronous.
vi.mock("@/lib/tauri/runtime", () => ({
  isTauri: () => false,
  loadTauriCore: vi.fn(),
}));

import { useCanvasFleetPush } from "../useCanvasFleetPush";
import { agentHeadlineStore } from "../../services/agent-headline-store";

describe("useCanvasFleetPush — a new ask has to reach the fleet", () => {
  // The gap this closes, found by reading the wiring rather than trusting it: this hook subscribed
  // ONLY to `agentStatusRegistry`. A running agent handed a brand-new instruction keeps its status,
  // so nothing here fired, so the new headline sat in the frontend store and `lotus_list_fleet` kept
  // serving the PREVIOUS ask to whichever agent was dispatching. Two layers had to change — this
  // subscription, and the scheduler's dedup key, which was justified by an assumption the headline
  // broke. A test on either alone would have passed while the feature stayed broken end to end.

  beforeEach(() => {
    handleSnapshot.mockClear();
    agentHeadlineStore.clear("canvas:p1:n1");
  });

  afterEach(() => {
    agentHeadlineStore.clear("canvas:p1:n1");
  });

  it("re-pushes when a headline changes and the status registry has not moved", () => {
    renderHook(() => useCanvasFleetPush({ projectId: "p1", cwd: "/repo" }));
    handleSnapshot.mockClear();

    act(() => {
      agentHeadlineStore.record("canvas:p1:n1", {
        text: "perbaiki judul agent",
        key: "prompt|perbaiki judul agent",
      });
    });

    expect(handleSnapshot).toHaveBeenCalled();
  });

  it("stays silent when the store decides the displayed line did not change", () => {
    // The store returns early on an unchanged key and never notifies, which is what keeps a board of
    // eight agents from re-pushing on every tool call.
    renderHook(() => useCanvasFleetPush({ projectId: "p1", cwd: "/repo" }));
    act(() => {
      agentHeadlineStore.record("canvas:p1:n1", { text: "running a command", key: "same" });
    });
    handleSnapshot.mockClear();

    act(() => {
      agentHeadlineStore.record("canvas:p1:n1", { text: "ran a command", key: "same" });
    });

    expect(handleSnapshot).not.toHaveBeenCalled();
  });

  it("stops listening when the board unmounts", () => {
    const { unmount } = renderHook(() => useCanvasFleetPush({ projectId: "p1", cwd: "/repo" }));

    unmount();
    handleSnapshot.mockClear();
    act(() => {
      agentHeadlineStore.record("canvas:p1:n1", { text: "halo", key: "prompt|halo" });
    });

    expect(handleSnapshot).not.toHaveBeenCalled();
  });
});

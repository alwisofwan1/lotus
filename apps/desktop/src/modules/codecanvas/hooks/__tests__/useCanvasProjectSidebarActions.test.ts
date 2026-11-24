import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CodeCanvasProjectMeta } from "@/lib/tauri/codecanvas";
import { useCanvasProjectSidebarActions } from "../useCanvasProjectSidebarActions";

const PROJECT: CodeCanvasProjectMeta = {
  id: "cp_demo",
  rootDir: "/repo/demo",
  alias: null,
  position: 0,
  updatedAt: 1,
  lastOpenedAt: 1,
};

function renderActions(overrides: Partial<Parameters<typeof useCanvasProjectSidebarActions>[0]> = {}) {
  return renderHook(() => useCanvasProjectSidebarActions({
    projects: [],
    activeProjectId: null,
    activeProject: null,
    loading: false,
    showPicker: false,
    nodes: [],
    edges: [],
    closeProject: vi.fn(),
    ...overrides,
  }));
}

describe("useCanvasProjectSidebarActions", () => {
  it("treats boot restore as a pending canvas, not as no project", () => {
    const { result } = renderActions({ loading: true });

    expect(result.current.showEmptyState).toBe(false);
    expect(result.current.showRestoringState).toBe(true);
  });

  it("shows the empty portal only after restore finishes with no active project", () => {
    const { result } = renderActions({ loading: false });

    expect(result.current.showEmptyState).toBe(true);
    expect(result.current.showRestoringState).toBe(false);
  });

  it("keeps an active project in the canvas state", () => {
    const { result } = renderActions({
      projects: [PROJECT],
      activeProjectId: PROJECT.id,
      activeProject: PROJECT,
    });

    expect(result.current.showEmptyState).toBe(false);
    expect(result.current.showRestoringState).toBe(false);
  });

  it("does NOT splash restoring on a project switch once booted — the canvas stays painted", () => {
    // A switch loads the next snapshot while a canvas is already up (booted). No loading screen:
    // the current canvas holds until the new nodes swap in, so the transition reads as instant.
    const { result } = renderActions({
      loading: true,
      booted: true,
      projects: [PROJECT],
      activeProjectId: PROJECT.id,
      activeProject: PROJECT,
    });

    expect(result.current.showRestoringState).toBe(false);
    expect(result.current.showEmptyState).toBe(false);
  });

  it("still splashes restoring on the first cold boot (not yet booted)", () => {
    const { result } = renderActions({ loading: true, booted: false });
    expect(result.current.showRestoringState).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { isPaneAttached, isPaneVisible } from "@/modules/workspace-shell/services/pane-visibility";

describe("isPaneVisible", () => {
  it("shows every pane when focus mode is off", () => {
    expect(isPaneVisible({ focusMode: false, focusedPaneId: "a", paneId: "b" })).toBe(true);
  });

  it("shows only the focused pane in focus mode", () => {
    expect(isPaneVisible({ focusMode: true, focusedPaneId: "a", paneId: "a" })).toBe(true);
    expect(isPaneVisible({ focusMode: true, focusedPaneId: "a", paneId: "b" })).toBe(false);
  });

  it("follows focus rather than remembering which pane was maximised", () => {
    // The bug this replaces: focus mode held its own pane id, so picking another pane in the
    // rail moved the focus and left the screen showing the pane from before.
    const rail = { focusMode: true, focusedPaneId: "c" };
    expect(isPaneVisible({ ...rail, paneId: "c" })).toBe(true);
    expect(isPaneVisible({ ...rail, paneId: "a" })).toBe(false);
  });

  it("falls back to showing everything when focus mode has no pane to show", () => {
    expect(isPaneVisible({ focusMode: true, focusedPaneId: null, paneId: "a" })).toBe(true);
  });
});

describe("isPaneAttached", () => {
  const base = { workspaceActive: true, modeShown: true, focusMode: false, focusedPaneId: null, paneId: "a" };

  /**
   * Measured in the native window, 2026-09-20: returning to Code cost p50 ~190 ms with two live
   * terminals and ~34 ms with none, and focus barely mattered (172 ms with a thread focused). The
   * reason is that telling a pane it is not visible RELEASES its pooled renderer slot — parked,
   * GPU context handed back — so coming back re-attaches every terminal one by one.
   *
   * A mode that is merely hidden is not a reason for that, now that the two surfaces are stacked
   * and the hidden one keeps its geometry (`visibility: hidden`, not `display: none`).
   */
  it("keeps a pane attached while its mode is merely hidden", () => {
    expect(isPaneAttached({ ...base, modeShown: false })).toBe(true);
  });

  it("keeps a pane attached while its workspace is merely hidden", () => {
    // Detaching here rebuilt every terminal on each switch, and a pane on its own renderer came
    // back as an empty xterm (native window, 2026-09-24). The workspace keeps its box.
    expect(isPaneAttached({ ...base, workspaceActive: false })).toBe(true);
  });

  it("ignores focus mode in a hidden workspace, which the stylesheet does not collapse", () => {
    expect(isPaneAttached({ ...base, workspaceActive: false, focusMode: true, focusedPaneId: "x", paneId: "b" })).toBe(true);
  });

  it("detaches the panes focus mode is hiding", () => {
    expect(isPaneAttached({ ...base, focusMode: true, focusedPaneId: "a", paneId: "b" })).toBe(false);
    expect(isPaneAttached({ ...base, focusMode: true, focusedPaneId: "a", paneId: "a" })).toBe(true);
  });
});

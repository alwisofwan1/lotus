import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LayoutTemplate } from "@/modules/codespace/components/types";
import { useCodeSpaceLaunchFlow } from "@/modules/codespace/hooks/useCodeSpaceLaunchFlow";

const template: LayoutTemplate = {
  id: "duo",
  name: "Duo",
  label: "Duo",
  description: "Two panes",
  rows: 1,
  cols: 2,
  sessions: 2,
};

describe("useCodeSpaceLaunchFlow", () => {
  it("opens the wizard, launches through the injected launcher, then returns to idle", async () => {
    const launchWorkspace = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useCodeSpaceLaunchFlow(launchWorkspace));

    act(() => result.current.handleOpenLayoutWizard());
    expect(result.current.wizardActive).toBe(true);

    await act(async () => {
      await result.current.launchWorkspace(template, "/tmp/project-launch", ["claude", ""], "Launch Workspace");
    });

    expect(launchWorkspace).toHaveBeenCalledWith(template, "/tmp/project-launch", ["claude", ""], "Launch Workspace");
    expect(result.current.view).toEqual({ name: "idle" });
  });
});

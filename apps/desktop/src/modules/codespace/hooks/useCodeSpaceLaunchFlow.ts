"use client";

import { useCallback, useState } from "react";
import type { LayoutTemplate } from "@/modules/codespace/components/types";

// The wizard is one screen (folder, layout and agents together), so there is no agents step to hold.
export type CodeSpaceView = { name: "idle" } | { name: "layout" } | { name: "launching" };

type LaunchWorkspaceFn = (
  template: LayoutTemplate,
  cwd: string,
  agentCommands: string[],
  workspaceLabel?: string,
) => Promise<unknown> | unknown;

export function useCodeSpaceLaunchFlow(launchWorkspace: LaunchWorkspaceFn) {
  const [view, setView] = useState<CodeSpaceView>({ name: "idle" });

  const launchFromTemplate = useCallback(async (
    template: LayoutTemplate,
    cwd: string,
    agentCommands: string[],
    workspaceLabel?: string,
  ) => {
    setView({ name: "launching" });
    try {
      await launchWorkspace(template, cwd, agentCommands, workspaceLabel);
    } finally {
      setView({ name: "idle" });
    }
  }, [launchWorkspace]);

  const handleOpenLayoutWizard = useCallback(() => {
    setView({ name: "layout" });
  }, []);

  const handleCancelWizard = useCallback(() => {
    setView({ name: "idle" });
  }, []);

  return {
    view,
    wizardActive: view.name === "layout",
    launching: view.name === "launching",
    launchWorkspace: launchFromTemplate,
    handleOpenLayoutWizard,
    handleCancelWizard,
  };
}

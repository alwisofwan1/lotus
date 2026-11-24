"use client";
import type { ComponentProps } from "react";
import Link from "next/link";
import { BrandMark } from "@/components/icons/BrandMark";
import { isDevBuild } from "@/lib/build-env";
import { CanvasControlCluster, type CanvasAppNav } from "./CanvasControlCluster";
import type { CanvasFrameSwitcher } from "./CanvasFrameSwitcher";
import type { CodeCanvasProjectMeta } from "@/lib/tauri/codecanvas";
import type { AgentDefinition } from "../types/canvas";
import { CanvasMachineStatus, type CanvasMachineStatusProps } from "./CanvasMachineStatus";

interface Props {
  projectName: string;
  /** Absent for a project on this machine — a local node stays unlabelled. */
  machine?: CanvasMachineStatusProps | null;
  onOpenSettings: () => void;
  onOpenCanvases?: () => void;
  /** Project switcher data + actions (canvas top-bar dropdown). */
  projects?: CodeCanvasProjectMeta[];
  activeProjectId?: string | null;
  projectRestoring?: boolean;
  onSelectProject?: (projectId: string) => void;
  onNewProject?: () => void;
  onCloseProject?: () => void;
  /** Frame chips, shown in the same cluster as the command bar (LOT2-137). */
  frameSwitcher?: ComponentProps<typeof CanvasFrameSwitcher>;
  /** The Dock button, as in the bottom command bar. */
  dock?: Pick<CanvasAppNav, "onToggleDock" | "dockOpen" | "dockWaiting" | "dockChord">;
  onToggleFrameOverview?: () => void;
  frameOverviewOpen?: boolean;
  /** @deprecated Agent launch moved to the ⌘K command palette (runner-first, ADR-0027). Accepted but unused. */
  onAddAgent?: (def: AgentDefinition, options?: { isolate?: boolean }) => void;
  /** @deprecated unused — see onAddAgent. */
  takenAgentNames?: string[];
}

/**
 * Top Bar mode: the same control cluster as the bottom command bar (one component, one control
 * size), plus what only the top edge carries — the DEV badge, the machine chip and the Lotus mark.
 * Non-interactive parts keep `data-tauri-drag-region` so the window stays draggable.
 */
export function CanvasTopBar({
  projectName,
  machine = null,
  onOpenSettings,
  onOpenCanvases,
  projects = [],
  activeProjectId = null,
  projectRestoring = false,
  onSelectProject,
  onNewProject,
  onCloseProject,
  frameSwitcher,
  dock,
  onToggleFrameOverview,
  frameOverviewOpen,
}: Props) {
  return (
    <div className="canvas-topbar" role="banner">
      <nav className="canvas-topnav" data-tauri-drag-region aria-label="Canvas">
        <CanvasControlCluster
          placement="down"
          projectRestoring={projectRestoring}
          frameSwitcher={frameSwitcher}
          nav={{
            projects,
            activeProjectId,
            fallbackName: projectName,
            onSelectProject: onSelectProject ?? (() => {}),
            onOpenCanvases: onOpenCanvases ?? (() => {}),
            onOpenSettings,
            onNewProject: onNewProject ?? (() => {}),
            onCloseProject: onCloseProject ?? (() => {}),
            ...dock,
            onToggleFrameOverview,
            frameOverviewOpen,
          }}
          projectAdornment={
            <>
              {isDevBuild() && <span className="canvas-topbar-dev" role="img" aria-label="Development build" title="Development build (tauri dev)" />}
              {machine ? <CanvasMachineStatus {...machine} placement="down" /> : null}
            </>
          }
        />
        <Link href="/" className="canvas-topbar-lotus-btn" aria-label="Home" title="Lotus Home">
          <BrandMark className="h-[16px] w-[16px]" />
        </Link>
      </nav>
    </div>
  );
}

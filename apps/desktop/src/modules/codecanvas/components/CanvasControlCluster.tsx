"use client";
import type { ComponentProps, ReactNode } from "react";
import { LayoutGrid, PanelRight, Settings } from "lucide-react";
import { describeDockWaiting, type CanvasDockWaiting } from "../hooks/useCanvasDock";
import type { CodeCanvasProjectMeta } from "@/lib/tauri/codecanvas";
import { CanvasFrameSwitcher } from "./CanvasFrameSwitcher";
import { CanvasProjectMenu } from "./CanvasProjectMenu";
import type { RemoteHostCell } from "../services/remote-host";
import type { SheetTrackerTask } from "../services/commands/command-sheet-items";

/** The app-effect channel: open projects + the navigation callbacks the chrome and NL intents share. */
export interface CanvasAppNav {
  projects: CodeCanvasProjectMeta[];
  activeProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  onOpenCanvases: () => void;
  onOpenSettings: () => void;
  /** Silence every voice the canvas speaks with (Cmd-K 'Stop All Speech', Lotus #176). */
  onStopAllSpeech?: () => void;
  onNewProject: () => void;
  /** Close a project by id; omit to close the currently-active one (the menu's arg-less usage). */
  onCloseProject: (projectId?: string) => void;
  /**
   * Take over a cell the project's machine already runs under its own Standalone Host.
   *
   * Optional, and absent on every machine that runs no host — which is why the ⌘K rows for it
   * simply do not exist there rather than appearing greyed out.
   */
  onAdoptHostCell?: (cell: RemoteHostCell) => void;
  /** Place an issue's Factory Run on the canvas, from ⌘K (#146). */
  onAddFactoryRun?: (run: { repo: string; issue: number | string; title: string }) => void;
  /**
   * The one Dock button (`plans/canvas-dock/`, revised 2026-10-16). It replaced the Fleet button:
   * Fleet, Automation and every later app sit on the Dock's own rail, so adding a feature never
   * adds a button here.
   */
  onToggleDock?: () => void;
  /** Open the Dock on Automation (⌘K "Open Automations"). */
  onOpenAutomation?: () => void;
  /** Open the Dock on Fleet (⌘K "Fleet"). */
  onOpenFleet?: () => void;
  /** ⌘K "From Tasks…": open tasks on the tracker board, and placing one here (board 18). */
  trackerTasks?: SheetTrackerTask[];
  onPlaceTask?: (task: SheetTrackerTask) => void;
  /** ⌘K "Open file…": place a File Node (plans/canvas-code, S3). */
  onOpenFile?: (path: string) => void;
  loadProjectFiles?: () => Promise<string[]>;
  rootDir?: string;
  dockOpen?: boolean;
  /** Each app with something waiting; the badge shows their sum. */
  dockWaiting?: readonly CanvasDockWaiting[];
  /** The Dock chord as bound, e.g. "⌘B", for the tooltip. */
  dockChord?: string;
  /** Grid button: enter or leave the Frame Overview (LOT2-125). Canvases lives in the project menu. */
  onToggleFrameOverview?: () => void;
  /** Whether the Frame Overview is open, so the grid button reads as pressed. */
  frameOverviewOpen?: boolean;
}

interface Props {
  nav: CanvasAppNav & { fallbackName?: string | null };
  frameSwitcher?: ComponentProps<typeof CanvasFrameSwitcher>;
  /** Which way the project dropdown opens: "up" from the bottom command bar, "down" from the Top Bar. */
  placement: "up" | "down";
  /** Mode-specific extras that live beside the project name (DEV badge, machine chip). */
  projectAdornment?: ReactNode;
  /** Shown instead of the project label while projects are still being restored. */
  projectRestoring?: boolean;
}

/**
 * The Top Bar's control cluster: [project] | [Frame chips · Overview · Dock · Settings].
 * One divider — "where" against "what" — instead of one per group.
 *
 * Every tile is `--cc-control` square with a 16px icon, so the two bars cannot drift apart again;
 * all sizing lives in `styles/canvas/canvas-control-cluster.css`.
 */
export function CanvasControlCluster({ nav, frameSwitcher, placement, projectAdornment, projectRestoring }: Props) {
  return (
    <div className="canvas-cc" data-placement={placement}>
      <div className="canvas-cc-group">
        <CanvasProjectMenu
          projects={nav.projects}
          activeProjectId={nav.activeProjectId}
          fallbackName={nav.fallbackName}
          restoring={projectRestoring}
          onSelectProject={nav.onSelectProject}
          onOpenCanvases={nav.onOpenCanvases}
          onNewProject={nav.onNewProject}
          onCloseProject={nav.onCloseProject}
          placement={placement}
        />
        {projectAdornment}
      </div>
      <span className="canvas-cc-div" aria-hidden />
      <div className="canvas-cc-group">
        {frameSwitcher ? <CanvasFrameSwitcher {...frameSwitcher} /> : null}
        <button
          type="button"
          className="canvas-nl-icon canvas-cc-btn"
          aria-label={nav.frameOverviewOpen ? "Leave Frame overview" : "Frame overview"}
          title={nav.frameOverviewOpen ? "Frame overview · on" : "Frame overview"}
          aria-pressed={!!nav.frameOverviewOpen}
          data-active={nav.frameOverviewOpen ? "true" : undefined}
          onClick={nav.onToggleFrameOverview}
        >
          <LayoutGrid size={15} strokeWidth={1.75} />
        </button>
        {nav.onToggleDock ? <DockButton nav={nav} /> : null}
        <button
          type="button"
          className="canvas-nl-icon canvas-cc-btn"
          aria-label="Canvas settings"
          title="Canvas Settings"
          onClick={nav.onOpenSettings}
        >
          <Settings size={15} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

/**
 * Quiet at rest: the same tile as every other control, a violet count only when something waits.
 * The tooltip names what waits, so the sum never hides which app it came from.
 */
function DockButton({ nav }: { nav: CanvasAppNav }) {
  const waiting = nav.dockWaiting ?? [];
  const total = waiting.reduce((sum, item) => sum + item.count, 0);
  const chord = nav.dockChord ? ` · ${nav.dockChord}` : "";
  const what = total > 0 ? ` · ${describeDockWaiting(waiting)}` : "";
  return (
    <button
      type="button"
      className="canvas-nl-icon canvas-cc-btn canvas-cc-dock"
      aria-label={`${nav.dockOpen ? "Hide" : "Show"} the Dock${total > 0 ? `, ${total} waiting` : ""}`}
      title={`Dock${nav.dockOpen ? " · on" : ""}${what}${chord}`}
      aria-pressed={!!nav.dockOpen}
      data-active={nav.dockOpen ? "true" : undefined}
      onClick={nav.onToggleDock}
    >
      <PanelRight size={15} strokeWidth={1.75} />
      {total > 0 ? <span className="canvas-dock-badge" aria-hidden>{total > 99 ? "99+" : total}</span> : null}
    </button>
  );
}

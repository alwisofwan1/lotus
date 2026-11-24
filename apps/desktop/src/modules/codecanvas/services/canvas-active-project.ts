import type { CodeCanvasProjectLocation } from "@/lib/tauri/codecanvas";
import { machineFromLocation, type Machine } from "./machine";

/**
 * The active canvas project's root directory **and machine**, published as a module singleton.
 *
 * The canvas runs one active project per window, and ReactFlow node components
 * (e.g. a browser node) sit far below the board hook that owns `rootDir`. Rather
 * than thread the path through every node's props, the board publishes it here and
 * leaf components read it on demand. Used as the confinement root when a browser
 * node opens a local `file://` URL, and — since the VPS connector — as the machine a node's PTY
 * should run on.
 *
 * The machine belongs to the project, not to the node: every node on a board shares it, and a node
 * that stored its own copy could disagree with the project it is drawn on. One owner, read on
 * demand, exactly as the root directory already works.
 */
let activeProjectRootDir = "";

export function setActiveProjectRootDir(rootDir: string | null | undefined): void {
  activeProjectRootDir = (rootDir ?? "").trim();
}

/** The active project root, or `undefined` when no project is open. */
export function getActiveProjectRootDir(): string | undefined {
  return activeProjectRootDir || undefined;
}

let activeProjectLocation: Machine | null = null;

/**
 * Normalised at this boundary, not at every reader: the SQLite row spells "no user" as `null`,
 * while everything downstream (`SshTarget`, `buildSshCommand`, the PTY controller) spells it as an
 * absent key. Converting once here is what lets a project's machine be handed straight to the PTY
 * seam with no per-caller mapping.
 */
export function setActiveProjectLocation(location: CodeCanvasProjectLocation | null | undefined): void {
  activeProjectLocation = machineFromLocation(location);
}

/** The active project's machine, or null when the project is on this one. */
export function getActiveProjectLocation(): Machine | null {
  return activeProjectLocation;
}

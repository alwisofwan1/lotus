import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HostedProject } from "../../types/index.js";
import { ExtraProjects } from "./extra-store.js";

/**
 * Hosted-project registry. With an explicit project list (or `PROJECTS_JSON`)
 * it is a fixed snapshot; with a `PROJECTS_ROOT` it re-scans the directory
 * **live** on every read, so a repo cloned into the workspace root after the
 * host started shows up as a first-class workspace with no restart (ADR-0019,
 * Slice 6).
 */
export class ProjectRegistry {
  constructor(
    private readonly projects: HostedProject[],
    private readonly scanRoot?: string,
    /** The writable list beside the scan — ADR-D. Absent on a host that has none. */
    private readonly extra?: ExtraProjects,
  ) {}

  /**
   * Every project this host holds: the scan, plus whatever the writable list adds.
   *
   * **The scan wins a collision**, and the collision is real rather than theoretical: an
   * operator can add a folder from the phone and later move it under `PROJECTS_ROOT`. Two
   * entries for one directory would make `workspaceId` ambiguous, and a cell would be
   * addressed by whichever id the client happened to hold.
   */
  list(): HostedProject[] {
    const scanned = this.scanRoot !== undefined ? scanProjects(this.scanRoot) : this.projects;
    if (this.extra === undefined) return scanned;
    const taken = new Set(scanned.map((p) => p.path));
    return [...scanned, ...this.extra.list().filter((p) => !taken.has(p.path))];
  }

  get(id: string): HostedProject | undefined {
    return this.list().find((p) => p.id === id);
  }

  static fromConfig(config: {
    projectsJson?: string;
    projectsRoot?: string;
    /** Path to the writable list. Absent leaves this host with the scan alone. */
    extraProjects?: string;
  }): ProjectRegistry {
    const extra = config.extraProjects === undefined
      ? undefined
      : new ExtraProjects(config.extraProjects);
    if (config.projectsJson) {
      const raw = readFileSync(config.projectsJson, "utf8");
      return new ProjectRegistry(JSON.parse(raw) as HostedProject[], undefined, extra);
    }
    if (config.projectsRoot) {
      return new ProjectRegistry([], config.projectsRoot, extra);
    }
    return new ProjectRegistry([], undefined, extra);
  }
}

/** One level of non-hidden subdirectories of `root`, each a `HostedProject`. */
function scanProjects(root: string): HostedProject[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return []; // root not created yet — no workspaces, not an error
  }
  const projects: HostedProject[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const fullPath = join(root, entry);
    try {
      if (!statSync(fullPath).isDirectory()) continue;
    } catch {
      continue; // entry vanished mid-scan — skip
    }
    projects.push({ id: entry, name: entry, path: fullPath });
  }
  return projects;
}

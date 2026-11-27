import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HostedProject } from "../../types/index.js";
import { ExtraProjects } from "./extra-store.js";

/** Rescan the configured root on reads so newly cloned workspaces appear without a restart (ADR-0019). */
export class ProjectRegistry {
  constructor(
    private readonly projects: HostedProject[],
    private readonly scanRoot?: string,
    /** The writable list beside the scan — ADR-D. Absent on a host that has none. */
    private readonly extra?: ExtraProjects,
  ) {}

  /** Prefer scanned entries on collision so one directory has one workspace ID. */
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

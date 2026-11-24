import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { atomicWriteJSON } from "../../core/atomic-write.js";
import { createLogger } from "../../core/logger.js";
import type { HostedProject } from "../../types/index.js";

interface ExtraFile {
  version: 1;
  projects: HostedProject[];
}

const log = createLogger();

/**
 * Projects that live outside `PROJECTS_ROOT`, kept in a small file this host may write.
 *
 * The third registry mode (ADR-D in `plans/pocket-vps-project-checkout`). `PROJECTS_JSON` is
 * **not** reused for it: that one is a snapshot the operator owns through env, and writing to
 * it from a phone would overwrite a hand-managed file. The alternative considered and rejected
 * was a symlink into the workspace root — zero registry code, because `scanProjects` follows
 * symlinks, but removing a project would then look like removing the repository, and an agent's
 * `cwd` would be the link rather than the real path.
 */
export class ExtraProjects {
  constructor(private readonly file: string) {}

  /**
   * The entries whose directory is there right now.
   *
   * A path that has gone is skipped rather than removed: a mounted disk can come back, and a
   * host that forgot a project because a volume was late is a host that loses work quietly.
   */
  list(): HostedProject[] {
    return this.read().filter((project) => isDirectory(project.path));
  }

  /** Adds one, unless this host already holds that path. */
  async add(project: HostedProject): Promise<void> {
    const held = this.read();
    if (held.some((p) => p.path === project.path)) return;
    await this.write([...held, project]);
  }

  /** Forgets one. The directory is never touched — only this host's claim on it. */
  async remove(id: string): Promise<void> {
    await this.write(this.read().filter((p) => p.id !== id));
  }

  private read(): HostedProject[] {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return []; // not written yet — the ordinary case on a fresh host
    }
    try {
      const parsed = JSON.parse(raw) as ExtraFile;
      return Array.isArray(parsed.projects) ? parsed.projects : [];
    } catch {
      // Loud, but not fatal: a host that refuses to start because one small file is corrupt
      // takes every project with it, including the ones the scan would have found anyway.
      log.warn("projects.extra.unreadable", { file: this.file });
      return [];
    }
  }

  private async write(projects: HostedProject[]): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true });
    const body: ExtraFile = { version: 1, projects };
    await atomicWriteJSON(this.file, body);
  }
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

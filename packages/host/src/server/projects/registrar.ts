import { realpathSync } from "node:fs";
import { basename } from "node:path";

import type { HostedProject } from "../../types/index.js";
import type { BrowseRoots } from "./browse.js";
import type { ExtraProjects } from "./extra-store.js";
import type { ProjectRegistry } from "./registry.js";

/** This host already holds that directory — through the scan, or through the list. */
export class AlreadyAProjectError extends Error {}

export interface ProjectRegistrarDeps {
  extra: ExtraProjects;
  /** Read to decide what is already held. Never written through. */
  registry: ProjectRegistry;
  /** The same jail browsing uses — a path that cannot be listed cannot be taken either. */
  browse: BrowseRoots;
  /**
   * `PROJECTS_ROOT`, when this host scans one. Taking it is refused: the scan already makes
   * every directory inside it a project, so the container would be listed beside its own
   * contents, one directory covered twice under two ids.
   *
   * Named separately from the browse roots because they are not the same thing — `~/kerja` is
   * a browse root that nothing scans, and taking *that* is exactly what this feature is for.
   */
  scanRoot?: string;
}

/**
 * Taking a directory that is already on the machine, and letting it go again.
 *
 * Nothing is copied and nothing is created. What changes is this host's **claim** on a folder
 * that was already there — which is why [remove] never touches the disk, and why the screen
 * above it says *nothing is copied* out loud.
 */
export class ProjectRegistrar {
  constructor(private readonly deps: ProjectRegistrarDeps) {}

  /**
   * Registers [path], answering with the project it became.
   *
   * Resolution happens through {@link BrowseRoots}, so the containment rule lives in exactly
   * one place: a path this host would refuse to *list* is one it refuses to take.
   */
  async add(path: string): Promise<HostedProject> {
    // `list` on the parent would be the wrong question; this asks the jail about the directory
    // itself and gets back its resolved path, which is what must be stored.
    const page = this.deps.browse.list(path);
    const real = page.path;

    // Resolved on both sides, for the reason `browse.ts` gives at length: `/tmp` is a symlink
    // to `/private/tmp` on macOS, and a comparison of unresolved strings would let the
    // workspace root through while looking correct.
    if (this.deps.scanRoot !== undefined && real === realOf(this.deps.scanRoot)) {
      throw new AlreadyAProjectError(`${real} is the workspace root — its contents are the projects`);
    }

    const held = this.deps.registry.list();
    if (held.some((p) => p.path === real)) {
      throw new AlreadyAProjectError(`${real} is already a project here`);
    }

    const project: HostedProject = {
      id: freeId(basename(real), held.map((p) => p.id)),
      name: basename(real),
      path: real,
    };
    await this.deps.extra.add(project);
    return project;
  }

  /** Forgets one. The directory stays exactly where it was. */
  async remove(id: string): Promise<void> {
    await this.deps.extra.remove(id);
  }
}

/**
 * `pocket`, then `pocket-2`, then `pocket-3`.
 *
 * Two directories on one machine can share a name, and `workspaceId` is what a cell is
 * addressed by — so a collision has to become a different id rather than a second entry under
 * the same one.
 */
function freeId(name: string, taken: string[]): string {
  if (!taken.includes(name)) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

function realOf(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null; // not there — it cannot be the root anything is scanned from
  }
}

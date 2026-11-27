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
  /** Reject the scan root itself so its child projects are not covered by a second registration. */
  scanRoot?: string;
}

/** Unregistering a project only removes the registry entry so the original folder stays intact. */
export class ProjectRegistrar {
  constructor(private readonly deps: ProjectRegistrarDeps) {}

  /** Reuse BrowseRoots containment so registration cannot accept paths the host would refuse to list. */
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

/** Disambiguate matching directory names because cells use workspace IDs for addressing. */
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

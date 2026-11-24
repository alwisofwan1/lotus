import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, sep } from "node:path";

import type { BrowseEntry, BrowsePage, BrowseRoot, NotTakeable } from "../../types/index.js";

/** The path asked for is not inside any root this host opens. */
export class OutsideRootsError extends Error {}

/** The path is not a directory this host can read. */
export class NotBrowsableError extends Error {}

/**
 * The only directories a phone may look at, and the rule that keeps it to them.
 *
 * ADR-A in `plans/pocket-vps-project-checkout`: the jail is the design. Three properties hold
 * here rather than in the UI above, because a UI is not a boundary:
 *
 *  - **Containment is checked on the resolved path, never on the string given.** A symlink
 *    inside a root that points at `/` would otherwise make the whole thing decorative —
 *    `..` is the obvious attack and the one every naive check catches; a symlink is the one
 *    it misses.
 *  - **Directories only.** File names are not sent, and file contents have no route at all.
 *    What a phone can learn about a machine is which folders exist, and nothing else.
 *  - **A root has no parent.** There is nothing above it to draw, so a client cannot render
 *    a dead control that teaches the operator something is up there.
 */
export interface BrowseFacts {
  /** The paths this host already holds as projects. Read fresh on every listing. */
  held?: () => string[];
  /** `PROJECTS_ROOT`, whose contents are already the projects and which cannot be taken. */
  scanRoot?: string;
}

export class BrowseRoots {
  private readonly configured: string[];

  constructor(roots: string[], private readonly facts: BrowseFacts = {}) {
    this.configured = roots;
  }

  /** The roots that exist right now, in the order they were configured. */
  roots(): BrowseRoot[] {
    return this.configured.flatMap((path) => {
      const real = resolved(path);
      if (real === null || !isDirectory(real)) return [];
      return [{ name: basename(real), path: real }];
    });
  }

  /** One level of [path], refusing anything the roots do not contain. */
  list(path: string): BrowsePage {
    const real = resolved(path);
    if (real === null) throw new NotBrowsableError(`${path} cannot be read`);
    const root = this.rootOf(real);
    if (root === undefined) throw new OutsideRootsError(`${path} is not inside an allowed root`);
    if (!isDirectory(real)) throw new NotBrowsableError(`${path} is not a directory`);

    const held = new Set(this.facts.held?.() ?? []);
    const whyNot = this.whyNotTakeable(real, held);
    return {
      path: real,
      // Null at a root even though the directory above it exists on disk: that is the whole
      // point, and the client draws no way up because there is none to draw.
      parent: real === root.path ? null : parentOf(real),
      entries: this.entriesOf(real, held),
      takeable: whyNot === null,
      whyNot,
    };
  }

  /** The same two refusals `ProjectRegistrar` enforces, said before the operator asks. */
  private whyNotTakeable(real: string, held: Set<string>): NotTakeable | null {
    const scanRoot = this.facts.scanRoot === undefined ? null : resolved(this.facts.scanRoot);
    if (scanRoot !== null && real === scanRoot) return "workspace-root";
    if (held.has(real)) return "already-a-project";
    return null;
  }

  private entriesOf(dir: string, held: Set<string>): BrowseEntry[] {
    const entries: BrowseEntry[] = [];
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.name.startsWith(".")) continue;
      const child = join(dir, item.name);
      if (!isDirectory(child)) continue;
      entries.push({
        name: item.name,
        path: child,
        ...gitFacts(child),
        children: countDirs(child),
        isProject: held.has(child),
      });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The root containing [real], if any. Compared as paths, never as prefixes of a string. */
  private rootOf(real: string): BrowseRoot | undefined {
    return this.roots().find((root) => real === root.path || real.startsWith(root.path + sep));
  }
}

/** Whether it is a repository, and the branch it is on when that can be read cheaply. */
function gitFacts(dir: string): { isRepo: boolean; branch: string | null } {
  let head: string;
  try {
    // Read rather than shelled out to: a listing runs this once per entry, and spawning `git`
    // twenty times to draw one screen is a cost the phone would feel.
    head = readFileSync(join(dir, ".git", "HEAD"), "utf8");
  } catch {
    // `.git` is there but `HEAD` could not be read: a worktree or submodule, where `.git` is a
    // *file* pointing elsewhere, or a clone still in flight, or a permission this host does not
    // have. All of them are repositories, and none of them can name a branch from here — so the
    // question asked is "is there a `.git` at all", not "is it a file".
    return { isRepo: exists(join(dir, ".git")), branch: null };
  }
  const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim());
  return { isRepo: true, branch: ref?.[1] ?? null };
}

function countDirs(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((item) => !item.name.startsWith(".") && isDirectory(join(dir, item.name)))
      .length;
  } catch {
    return 0; // unreadable — a count of zero is better than refusing the whole listing
  }
}

/** `realpath`, or null when it cannot be resolved. Symlinks are followed here, once. */
function resolved(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function parentOf(path: string): string {
  const at = path.lastIndexOf(sep);
  return at <= 0 ? sep : path.slice(0, at);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

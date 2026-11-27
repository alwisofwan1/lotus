import { execFileSync } from "node:child_process";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync, type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";

import { DIRS, FILES, mergeDir, mergeFile } from "./context-links.js";

/** Mirrors desktop `ccs_migration.rs` (plans/portable-accounts/issues/08), for a host with no desktop. */
export interface CcsPlan {
  backup: string;
  merges: { from: string; to: string; collisions: number }[];
  /** `to: null`: nothing outside `~/.ccs` to point at, left as it is. */
  relinks: { link: string; to: string | null }[];
  defaultAccount: string | null;
  mcpEntries: McpEntry[];
}

export interface McpEntry { file: string; name: string }

export interface CcsMigrationDeps {
  home: string;
  stateDir: string;
  today: () => string;
  /** Whether this host already has a chosen account; ccs's default is adopted only when not. */
  hasDefault: () => boolean;
  setDefault: (id: string) => void;
}

const lstatOrNull = (p: string): Stats | null => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};
const children = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((n) => n !== ".DS_Store").sort().map((n) => join(dir, n));
  } catch {
    return [];
  }
};
const isLink = (p: string): boolean => lstatOrNull(p)?.isSymbolicLink() === true;
const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

export class CcsMigration {
  constructor(private readonly deps: CcsMigrationDeps) {}

  private get ccs(): string { return join(this.deps.home, ".ccs"); }
  private get claude(): string { return join(this.deps.home, ".claude"); }

  /** What `run` would do, writing nothing; null when this host has no `~/.ccs`. */
  plan(): CcsPlan | null {
    if (!existsSync(this.ccs)) return null;
    const def = this.ccsDefault();
    return {
      backup: this.backupPath(),
      merges: this.mergePairs().map(([from, to]) => ({ from, to, collisions: collisions(from, to) })),
      relinks: this.instances().flatMap((dir) => this.ccsLinks(dir)).map((link) => ({ link, to: this.relinkTarget(link) })),
      defaultAccount: !this.deps.hasDefault() && def !== null && existsSync(join(this.ccs, "instances", def, ".claude.json")) ? def : null,
      mcpEntries: this.mcpEntries(),
    };
  }

  /** Backs up what it changes, then merges and re-points; a second run picks up where the first stopped. */
  run(): CcsPlan {
    const plan = this.plan();
    if (plan === null) throw new Error("this host has no ~/.ccs");
    this.backup(plan.backup);
    for (const m of plan.merges) {
      if (lstatSync(m.from).isDirectory()) mergeDir(m.from, m.to);
      else mergeFile(m.from, m.to);
    }
    unionMemoryIndexes(join(this.claude, "projects"));
    for (const r of plan.relinks) {
      if (r.to === null) continue;
      const isDir = DIRS.includes(basename(r.link)) || (existsSync(r.to) && statSync(r.to).isDirectory());
      if (isDir) mkdirSync(r.to, { recursive: true });
      unlinkSync(r.link);
      symlinkSync(r.to, r.link, isDir ? "junction" : "file");
    }
    if (plan.defaultAccount !== null) this.deps.setDefault(plan.defaultAccount);
    return plan;
  }

  /** Drops every `ccs-*` MCP server from `~/.claude.json` and each instance's; other keys are kept. */
  removeMcp(): McpEntry[] {
    const removed = this.mcpEntries();
    for (const file of this.claudeConfigs()) {
      const config = JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> };
      const names = ccsServers(config);
      if (names.length === 0 || config.mcpServers === undefined) continue;
      for (const n of names) delete config.mcpServers[n];
      // Claude rewrites this file too: keep the original beside it, and swap the new one in whole.
      copyFileSync(file, `${file}.before-ccs-mcp-removal`);
      writeFileSync(`${file}.lotus-tmp`, JSON.stringify(config, null, 2));
      renameSync(`${file}.lotus-tmp`, file);
    }
    return removed;
  }

  private instances(): string[] {
    return children(join(this.ccs, "instances")).filter((p) => lstatOrNull(p)?.isDirectory() === true);
  }

  private mergePairs(): [string, string][] {
    const shared = join(this.ccs, "shared");
    const out: [string, string][] = [];
    for (const group of children(join(shared, "context-groups"))) {
      out.push([join(group, "projects"), join(this.claude, "projects")]);
      for (const entry of children(join(group, "continuity"))) out.push([entry, join(this.claude, basename(entry))]);
    }
    for (const slug of children(join(shared, "memory"))) out.push([slug, join(this.claude, "projects", basename(slug), "memory")]);
    for (const name of [...DIRS, ...FILES]) out.push([join(shared, name), join(this.claude, name)]);
    return out.filter(([from]) => { const s = lstatOrNull(from); return s !== null && !s.isSymbolicLink(); });
  }

  /** Links in an instance whose own target is under `~/.ccs`. */
  private ccsLinks(dir: string): string[] {
    return children(dir).filter((p) => {
      if (!isLink(p)) return false;
      const raw = readlinkSync(p);
      return within(isAbsolute(raw) ? raw : join(dir, raw), this.ccs);
    });
  }

  /** A shared-context entry goes to `~/.claude/<entry>`; any other to where its chain ends, if outside `~/.ccs`. */
  private relinkTarget(link: string): string | null {
    const name = basename(link);
    if (DIRS.includes(name) || FILES.includes(name)) return join(this.claude, name);
    try {
      const end = realpathSync(link);
      return within(end, realpathSync(this.ccs)) ? null : end;
    } catch {
      return null;
    }
  }

  private ccsDefault(): string | null {
    try {
      const line = readFileSync(join(this.ccs, "config.yaml"), "utf8").split("\n").find((l) => l.startsWith("default:"));
      const value = line?.slice("default:".length).trim().replace(/^["']|["']$/g, "") ?? "";
      return value === "" ? null : value;
    } catch {
      return null;
    }
  }

  private claudeConfigs(): string[] {
    return [join(this.deps.home, ".claude.json"), ...this.instances().map((d) => join(d, ".claude.json"))].filter((f) => existsSync(f));
  }

  private mcpEntries(): McpEntry[] {
    return this.claudeConfigs().flatMap((file) => {
      try {
        return ccsServers(JSON.parse(readFileSync(file, "utf8"))).map((name) => ({ file, name }));
      } catch {
        return [];
      }
    });
  }

  /** Never the name of an earlier backup: a second run must not overwrite the one taken before the first. */
  private backupPath(): string {
    const dir = join(this.deps.stateDir, "backups");
    for (let n = 1; ; n++) {
      const path = join(dir, n === 1 ? `ccs-${this.deps.today()}.tar.gz` : `ccs-${this.deps.today()}-${n}.tar.gz`);
      if (!existsSync(path)) return path;
    }
  }

  /** Only what the migration changes: `shared/`, `config.yaml`, each instance's top-level links (no `-h`). */
  private backup(to: string): void {
    mkdirSync(dirname(to), { recursive: true });
    const paths = [join(this.ccs, "shared"), join(this.ccs, "config.yaml")].filter((p) => existsSync(p));
    for (const dir of this.instances()) paths.push(...children(dir).filter(isLink));
    execFileSync("tar", ["-czf", to, "-C", this.deps.home, ...paths.map((p) => relative(this.deps.home, p))]);
  }
}

function ccsServers(config: { mcpServers?: unknown }): string[] {
  const servers = config.mcpServers;
  return servers !== null && typeof servers === "object" ? Object.keys(servers).filter((k) => k.startsWith("ccs-")) : [];
}

function collisions(from: string, to: string): number {
  const s = lstatOrNull(from);
  if (s === null || !s.isDirectory()) return existsSync(to) ? 1 : 0;
  return children(from).reduce((n, entry) => n + collisions(entry, join(to, basename(entry))), 0);
}

/** Two `MEMORY.md` for one project: the loser's missing lines are appended, so no memory is orphaned. */
function unionMemoryIndexes(projects: string): void {
  for (const project of children(projects)) {
    const index = join(project, "memory/MEMORY.md");
    const loser = `${index}.lotus-recovered`;
    if (!existsSync(index) || !existsSync(loser)) continue;
    let text = readFileSync(index, "utf8");
    const have = new Set(text.split("\n"));
    const missing = readFileSync(loser, "utf8").split("\n").filter((l) => l.trim() !== "" && !have.has(l));
    if (missing.length > 0) {
      if (!text.endsWith("\n")) text += "\n";
      writeFileSync(index, text + missing.map((l) => `${l}\n`).join(""));
    }
    unlinkSync(loser);
  }
}

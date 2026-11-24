import type { Git } from "../../core/git.js";

/** Longest diff the route ships. Past this the phone reads the rest on the machine. */
export const MAX_DIFF_BYTES = 64 * 1024;

/** Untracked files get a real line count each; past this many they are listed unmeasured. */
const MAX_UNTRACKED_MEASURED = 20;

export type { Git };

export type ChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  /** Null for a binary file, or an untracked one past the measuring cap. */
  added: number | null;
  removed: number | null;
}

export type ChangesReason = "not_a_repo" | "git_failed";

/**
 * What differs from `HEAD` in the working tree: tracked changes with their numstat,
 * plus untracked files — the case the hook ring can never see, and the only source of
 * truth for a runner that reports nothing (Codex).
 */
export async function listChanges(
  git: Git,
  cwd: string,
): Promise<{ files: ChangedFile[] } | { reason: ChangesReason }> {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return { reason: "not_a_repo" };

  const status = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.code !== 0) return { reason: "git_failed" };
  const numstat = await git(cwd, ["diff", "--numstat", "HEAD", "--"]);
  if (numstat.code > 1) return { reason: "git_failed" };

  const stats = parseNumstat(numstat.stdout);
  const files: ChangedFile[] = [];
  let measured = 0;
  for (const entry of parsePorcelain(status.stdout)) {
    if (entry.status === "untracked") {
      let added: number | null = null;
      if (measured < MAX_UNTRACKED_MEASURED) {
        measured++;
        const n = await git(cwd, ["diff", "--no-index", "--numstat", "--", "/dev/null", entry.path]);
        added = parseNumstat(n.stdout)[0]?.added ?? null;
      }
      files.push({ path: entry.path, status: "untracked", added, removed: added === null ? null : 0 });
      continue;
    }
    const stat = stats.find((s) => s.path === entry.path);
    files.push({
      path: entry.path,
      status: entry.status,
      added: stat?.added ?? null,
      removed: stat?.removed ?? null,
    });
  }
  return { files };
}

/**
 * One file's unified diff against `HEAD`; an untracked file is diffed against nothing so
 * it reads as all additions, like the phone's `+n −0` for it.
 */
export async function readDiff(
  git: Git,
  cwd: string,
  file: string,
): Promise<{ diff: string; truncated: boolean }> {
  let out = await git(cwd, ["diff", "HEAD", "--", file]);
  if (out.stdout.length === 0) {
    out = await git(cwd, ["diff", "--no-index", "--", "/dev/null", file]);
  }
  const truncated = Buffer.byteLength(out.stdout, "utf8") > MAX_DIFF_BYTES;
  return {
    diff: truncated ? Buffer.from(out.stdout, "utf8").subarray(0, MAX_DIFF_BYTES).toString("utf8") : out.stdout,
    truncated,
  };
}

/** A path the route will hand to git: relative, inside the tree, no traversal. */
export function isSafeRelativePath(file: string): boolean {
  if (file.length === 0 || file.startsWith("/") || file.startsWith("\\")) return false;
  if (file.includes("\0")) return false;
  return !file.split(/[\\/]/).some((part) => part === "..");
}

/** `git status --porcelain=v1 -z`: `XY path\0` with a second `\0orig` after a rename. */
export function parsePorcelain(raw: string): Array<{ path: string; status: ChangeStatus }> {
  const parts = raw.split("\0").filter((p) => p.length > 0);
  const out: Array<{ path: string; status: ChangeStatus }> = [];
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i]!;
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    if (xy === "??") {
      out.push({ path, status: "untracked" });
      continue;
    }
    if (xy.includes("R") || xy.includes("C")) {
      i++; // the original path follows as its own record
      out.push({ path, status: "renamed" });
      continue;
    }
    if (xy.includes("D")) out.push({ path, status: "deleted" });
    else if (xy.includes("A")) out.push({ path, status: "added" });
    else out.push({ path, status: "modified" });
  }
  return out;
}

/** `git diff --numstat`: `added\tremoved\tpath`, with `-` for a binary file. */
export function parseNumstat(raw: string): Array<{ path: string; added: number | null; removed: number | null }> {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [a, r, ...rest] = line.split("\t");
      const path = rest.join("\t");
      return {
        path,
        added: a === "-" ? null : Number(a),
        removed: r === "-" ? null : Number(r),
      };
    });
}

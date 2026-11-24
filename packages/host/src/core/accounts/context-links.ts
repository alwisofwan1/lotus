import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmdirSync, statSync, symlinkSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Linked only once the shared dir has them: a dangling link would be replaced on the CLI's first write. */
export const FILES = ["settings.json", "CLAUDE.md"];
export const DIRS = ["skills", "agents", "commands", "projects", "file-history", "todos", "shell-snapshots", "session-env"];
const ISOLATED_MARK = ".lotus-isolated";

export const isIsolated = (dir: string): boolean => existsSync(join(dir, ISOLATED_MARK));
export const markIsolated = (dir: string): void => writeFileSync(join(dir, ISOLATED_MARK), "");

const lstatOrNull = (p: string): Stats | null => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};
const recovered = (target: string): string => join(dirname(target), `${basename(target)}.lotus-recovered`);

/** Mirrors desktop `account_context::keep`: link each entry of `dir` to `shared/<entry>`, merging what stood there (newer wins). */
export function keepLinks(shared: string, dir: string): void {
  if (isIsolated(dir)) return;
  for (const name of DIRS) {
    mkdirSync(join(shared, name), { recursive: true });
    place(join(dir, name), join(shared, name), true);
  }
  for (const name of FILES) {
    if (!existsSync(join(shared, name)) && lstatOrNull(join(dir, name)) === null) continue;
    place(join(dir, name), join(shared, name), false);
  }
}

function place(path: string, target: string, isDir: boolean): void {
  // shortcut: Windows files are copies synced newer-wins (a file symlink needs developer mode); hosts run on Linux today.
  if (process.platform === "win32" && !isDir) return syncCopy(path, target);
  const stat = lstatOrNull(path);
  if (stat?.isSymbolicLink()) return;
  if (stat?.isDirectory()) {
    mergeDir(path, target);
    rmdirSync(path);
  } else if (stat !== null) mergeFile(path, target);
  symlinkSync(target, path, isDir ? "junction" : "file");
}

const mtime = (p: string): number => lstatOrNull(p)?.mtimeMs ?? 0;

export function mergeFile(path: string, target: string): void {
  if (lstatOrNull(target) === null) return renameSync(path, target);
  if (mtime(path) > mtime(target)) {
    renameSync(target, recovered(target));
    renameSync(path, target);
  } else renameSync(path, recovered(target));
}

export function mergeDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    const there = lstatOrNull(dst);
    if (entry.isDirectory() && there?.isDirectory()) {
      mergeDir(src, dst);
      rmdirSync(src);
    } else if (there !== null && (entry.isDirectory() || there.isDirectory())) renameSync(src, recovered(dst));
    else mergeFile(src, dst);
  }
}

function syncCopy(path: string, target: string): void {
  const [a, b] = [existsSync(path), existsSync(target)];
  if (!a && b) copyFileSync(target, path);
  else if (a && !b) copyFileSync(path, target);
  else if (a && b && statSync(path).mtimeMs > statSync(target).mtimeMs) copyFileSync(path, target);
  else if (a && b && statSync(target).mtimeMs > statSync(path).mtimeMs) copyFileSync(target, path);
}

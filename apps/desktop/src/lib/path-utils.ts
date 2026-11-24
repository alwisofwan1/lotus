/**
 * Minimal path utilities for browser/Tauri environments where Node's `path`
 * module is unavailable at runtime.  Covers only the subset used by the
 * editor — forward-slash semantics throughout.
 */

function normalise(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Returns the portion of `filePath` relative to `rootDir`. */
export function relative(rootDir: string, filePath: string): string {
  const root = normalise(rootDir).replace(/\/+$/, "");
  const file = normalise(filePath);
  if (file.startsWith(`${root}/`)) {
    return file.slice(root.length + 1);
  }
  return file;
}

/** Returns the last segment of a path (filename). */
export function basename(p: string): string {
  return normalise(p).split("/").pop() ?? p;
}

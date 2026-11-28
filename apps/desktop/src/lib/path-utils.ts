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

/**
 * The separator paths under `root` are joined with: the root's own. Rust's editor listing joins
 * the same way (`listing_separator` in `editor_fs.rs`), so a file reached from the tree and from
 * Go-to-file is one string — `C:\proj\a.ts` and `//wsl.localhost/Ubuntu/proj/a.ts` alike.
 */
export function separatorOf(root: string): "\\" | "/" {
  return root.includes("\\") ? "\\" : "/";
}

/** `path` without trailing separators of either kind (`/` becomes `""`, so joins stay single). */
export function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

/** `relative` (written with `/`) joined under `root` with the root's own separator. */
export function joinUnder(root: string, relative: string): string {
  const separator = separatorOf(root);
  const tail = separator === "\\" ? relative.replace(/\//g, "\\") : relative;
  return `${trimTrailingSeparators(root)}${separator}${tail}`;
}

/**
 * The part of `path` below `base`, when `path` lies strictly under it; otherwise `null`. Accepts
 * either separator at the boundary, so a listing spelled with `\` on Windows is still found under
 * its folder — matching only `/` once hid every file of every local Windows workspace.
 */
export function pathUnder(base: string, path: string): string | null {
  const trimmed = trimTrailingSeparators(base);
  if (path.length <= trimmed.length + 1 || !path.startsWith(trimmed)) return null;
  const boundary = path[trimmed.length];
  return boundary === "/" || boundary === "\\" ? path.slice(trimmed.length + 1) : null;
}

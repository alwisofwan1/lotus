// The Workbench Files pane (#282, mockup `lotus-chat.fig` page "05b Files"). Pure: what in a reply
// is a file reference, which file in the chat's folder it means, and the folder as a tree.

export interface FileRef {
  path: string;
  /** 1-based; null opens at the top. */
  line: number | null;
}

// A path-looking token: no spaces, a letter-led extension, an optional `:line`, `:line:col`, `#L3`
// or `#page=3` (a PDF's line is its page).
const REF = /^([\w@~.+-]*(?:\/[\w@~.+-]+)*\.[A-Za-z][\w]{0,9}|[\w@~.+-]+(?:\/[\w@~.+-]+)+)(?::(\d+)(?::\d+)?|#L(\d+)|#page=(\d+))?$/;

/** `src/a.ts:21`, `a.ts`, `/abs/a.ts#L3` → a ref; anything else (`npm test`, `v1.2`) → null. */
export function parseFileRef(text: string): FileRef | null {
  const match = REF.exec(text.trim());
  if (!match) return null;
  const line = match[2] ?? match[3] ?? match[4];
  return { path: match[1], line: line ? Number(line) : null };
}

/**
 * The file in `files` (relative to `cwd`) a reference means: the exact path, an absolute path
 * inside `cwd`, or a unique trailing match (`LoginForm.tsx` → `src/auth/LoginForm.tsx`).
 * An absolute path to a file outside `cwd` (a note in another folder) is returned as is: it can
 * only mean that one file. Ambiguous or missing → null, so nothing opens the wrong file.
 */
export function resolveFile(files: ReadonlySet<string>, path: string, cwd: string): string | null {
  let rel = path.replace(/^\.\//, "");
  const base = cwd.replace(/\/+$/, "") + "/";
  if (rel.startsWith(base)) rel = rel.slice(base.length);
  if (files.has(rel)) return rel;
  // shortcut: an outside file is not checked to exist; a missing one shows its read error when opened.
  if (rel.startsWith("/")) return /\/[^/]+\.[A-Za-z]\w*$/.test(rel) ? rel : null;
  const tail = "/" + rel;
  let found: string | null = null;
  for (const f of files) {
    if (!f.endsWith(tail)) continue;
    if (found) return null;
    found = f;
  }
  return found;
}

/** A resolved path on disk: an outside file is already absolute, a folder file joins `cwd`. */
export function absPath(cwd: string, path: string): string {
  return path.startsWith("/") ? path : `${cwd.replace(/\/+$/, "")}/${path}`;
}

/**
 * What a reply names as files, in order and once each: inline code spans and link targets
 * (`file://` decoded), never what sits inside a code block. Unresolved; the caller checks each.
 */
export function mentionedPaths(text: string): string[] {
  const prose = text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
  const found = new Set<string>();
  for (const match of prose.matchAll(/`([^`\n]+)`|\]\(<?([^)\s>]+)>?\)/g)) {
    let raw = match[1] ?? match[2];
    if (match[2] !== undefined) {
      if (/^file:\/\//i.test(raw)) raw = safeDecodeUri(raw.slice(7));
      else if (/^[a-z][\w+.-]*:/i.test(raw)) continue;
    }
    const ref = parseFileRef(raw);
    if (ref) found.add(ref.path);
  }
  return [...found];
}

function safeDecodeUri(text: string): string {
  try {
    return decodeURI(text);
  } catch {
    return text;
  }
}

export interface TreeEntry {
  name: string;
  /** Relative to the chat's folder; a folder's has no trailing slash. */
  path: string;
  folder: boolean;
}

/**
 * Each folder's direct children ("" is the root), folders first, then by name. `dirs` adds folders
 * the file list cannot show: an empty one just made.
 */
export function treeIndex(files: readonly string[], dirs: readonly string[] = []): Map<string, TreeEntry[]> {
  const tree = new Map<string, TreeEntry[]>();
  const add = (dir: string, entry: TreeEntry) => {
    const list = tree.get(dir);
    if (list) list.push(entry);
    else tree.set(dir, [entry]);
  };
  // A folder is written with a trailing "/", so every one of its parts is a folder.
  for (const file of [...files, ...dirs.map((dir) => `${dir}/`)]) {
    const parts = file.split("/");
    const last = file.endsWith("/") ? parts.length - 1 : parts.length;
    for (let i = 0; i < last; i++) {
      const path = parts.slice(0, i + 1).join("/");
      const folder = i < parts.length - 1;
      if (folder && tree.has(path)) continue;
      add(parts.slice(0, i).join("/"), { name: parts[i], path, folder });
      if (folder) tree.set(path, []);
    }
  }
  const order = (a: TreeEntry, b: TreeEntry) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name);
  for (const list of tree.values()) list.sort(order);
  return tree;
}

/** ⌘P and `@`: names that start with the query, then names that contain it, then paths that do,
 *  then names holding its letters in order (`chcmp` → `ChatComposer.tsx`); at most `limit`.
 *  A folder ends in `/`; its name is its last segment. */
export function filterFiles(files: readonly string[], query: string, limit = 80): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const byStart: string[] = [];
  const byName: string[] = [];
  const byPath: string[] = [];
  const byLetters: string[] = [];
  for (const f of files) {
    const lower = f.toLowerCase().replace(/\/$/, "");
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    if (name.startsWith(q)) byStart.push(f);
    else if (name.includes(q)) byName.push(f);
    else if (lower.includes(q)) byPath.push(f);
    else if (q.length > 1 && byLetters.length < limit && inOrder(q, name)) byLetters.push(f);
    if (byStart.length >= limit) break;
  }
  return [...byStart, ...byName, ...byPath, ...byLetters].slice(0, limit);
}

function inOrder(query: string, text: string): boolean {
  let at = 0;
  for (const ch of text) if (ch === query[at] && ++at === query.length) return true;
  return false;
}

/** The files plus every folder above them (`a/`, `a/b/`), so `@` can name a folder too. */
export function withFolders(files: readonly string[]): string[] {
  const folders = new Set<string>();
  for (const f of files) {
    for (let at = f.indexOf("/"); at >= 0; at = f.indexOf("/", at + 1)) folders.add(f.slice(0, at + 1));
  }
  return [...folders, ...files];
}

/** Changed paths are relative to the repository; the tree is relative to the chat's folder. */
export function changedInFolder(paths: readonly string[], prefix: string): Set<string> {
  return new Set(paths.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)));
}

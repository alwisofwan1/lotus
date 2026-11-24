/**
 * Links an agent writes to a file in the workspace: `src/x.ts`, `src/x.ts:10`, `src/x.ts:10:5`,
 * `src/x.ts:10-12`, `src/x.ts#L10`, `src/x.ts#L10-L20`, `README.md:10`, or a `file://` URL.
 */
export type FileLink = { path: string; startLine?: number; endLine?: number };

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;
/** Schemes that are never a file, even when a number follows the colon (`tel:123`). */
const NON_FILE_SCHEMES = new Set([
  "http", "https", "mailto", "tel", "sms", "ftp", "javascript", "data", "vbscript", "blob", "about", "ws", "wss",
]);
const WINDOWS_DRIVE_RE = /^[a-z]:[\\/]/i;
/** `README.md:10`, `Makefile:3:2`, `x.json:5-9` — a colon followed only by a line reference. */
const BARE_LINE_REF_RE = /^[^/\\:]+:\d+(?::\d+|-\d+)?$/;
const HASH_RANGE_RE = /^L(\d+)(?:-L?(\d+))?$/i;
const COLON_RANGE_RE = /^(.*?):(\d+)(?:(?::\d+)|(?:-(\d+)))?$/;

function withRange(path: string, start: string, end?: string): FileLink {
  const a = Number(start);
  const b = end ? Number(end) : a;
  return { path, startLine: Math.min(a, b), endLine: Math.max(a, b) };
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** True for hrefs a markdown renderer should keep so a click can reach `parseFileLink`. */
export function isFileLinkHref(href: string): boolean {
  return parseFileLink(href) !== null;
}

export function parseFileLink(href: string): FileLink | null {
  let rest = href.trim();
  if (!rest || rest.startsWith("#")) return null;
  if (/^file:\/\//i.test(rest)) {
    rest = rest.replace(/^file:\/\//i, "");
    // `file:///C:/x` carries the drive after a slash.
    if (/^\/[a-z]:[\\/]/i.test(rest)) rest = rest.slice(1);
  } else {
    const scheme = SCHEME_RE.exec(rest)?.[1]?.toLowerCase();
    if (scheme && !WINDOWS_DRIVE_RE.test(rest)) {
      if (NON_FILE_SCHEMES.has(scheme) || !BARE_LINE_REF_RE.test(rest)) return null;
    }
  }

  const hashAt = rest.indexOf("#");
  if (hashAt >= 0) {
    const path = decode(rest.slice(0, hashAt));
    if (!path) return null;
    const range = HASH_RANGE_RE.exec(rest.slice(hashAt + 1));
    return range ? withRange(path, range[1], range[2]) : { path };
  }

  const colon = COLON_RANGE_RE.exec(rest);
  if (colon && colon[1] && !/^[a-z]$/i.test(colon[1])) return withRange(decode(colon[1]), colon[2], colon[3]);
  return { path: decode(rest) };
}

function isAbsolute(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || WINDOWS_DRIVE_RE.test(path);
}

function normalize(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  const drive = /^[a-z]:(?=\/|$)/i.exec(slashed)?.[0] ?? "";
  const body = slashed.slice(drive.length);
  const absolute = body.startsWith("/");
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return `${drive}${absolute ? "/" : ""}..`;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${drive}${absolute ? "/" : ""}${parts.join("/")}`;
}

/** A relative link is relative to the folder the agent works in, not to the workspace root. */
export function absoluteLinkPath(path: string, baseDir: string): string {
  return isAbsolute(path) ? path : normalize(`${baseDir}/${path}`);
}

export type ResolvedFileLink = { ok: true; path: string } | { ok: false; reason: string };

/** Relative paths resolve against the root; anything that lands outside the root is refused. */
export function resolveFileLink(path: string, rootDir: string): ResolvedFileLink {
  const root = normalize(rootDir);
  const candidate = normalize(isAbsolute(path) ? path : `${root}/${path}`);
  if (candidate === root || candidate.startsWith(`${root}/`)) return { ok: true, path: candidate };
  return { ok: false, reason: `${path} is outside the workspace (${root}), so it was not opened.` };
}

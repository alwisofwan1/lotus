/*
 * `.editorconfig` (https://spec.editorconfig.org): a project's own rules for indentation, line
 * endings and what a save tidies. The files are read from the edited file's folder upwards, until
 * one says `root = true`; a closer file wins over a farther one, and a later section over an
 * earlier one in the same file.
 */

export type EditorConfig = {
  indentStyle?: "space" | "tab";
  /** Columns of one indent level. */
  indentSize?: number;
  /** Columns a tab shows as. */
  tabWidth?: number;
  endOfLine?: "LF" | "CRLF";
  trimTrailingWhitespace?: boolean;
  insertFinalNewline?: boolean;
};

type Section = { glob: string; properties: Record<string, string> };
export type ParsedEditorConfig = { root: boolean; sections: Section[] };

export function parseEditorConfig(text: string): ParsedEditorConfig {
  const parsed: ParsedEditorConfig = { root: false, sections: [] };
  let current: Section | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[(.*)\]$/.exec(line);
    if (header) {
      current = { glob: header[1], properties: {} };
      parsed.sections.push(current);
      continue;
    }
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim().toLowerCase();
    const value = line.slice(equals + 1).trim();
    if (current) current.properties[key] = value.toLowerCase();
    else if (key === "root") parsed.root = value.toLowerCase() === "true";
  }
  return parsed;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Index of the brace closing the one at `open`, or -1. */
function closingBrace(glob: string, open: number): number {
  let depth = 0;
  for (let index = open; index < glob.length; index += 1) {
    if (glob[index] === "\\") index += 1;
    else if (glob[index] === "{") depth += 1;
    else if (glob[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

/** Commas of the brace body at depth 0. */
function splitAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "\\") index += 1;
    else if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

function globBody(glob: string): string {
  let out = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "\\") {
      out += escapeRegex(glob[index + 1] ?? "");
      index += 1;
    } else if (char === "*") {
      if (glob[index + 1] === "*") {
        // `a/**/b` also matches `a/b`.
        if (glob[index + 2] === "/") {
          out += "(?:.*/)?";
          index += 2;
        } else {
          out += ".*";
          index += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "[") {
      const close = glob.indexOf("]", index + 1);
      if (close < 0) {
        out += "\\[";
      } else {
        const inner = glob.slice(index + 1, close);
        out += inner.startsWith("!") ? `[^${inner.slice(1).replace(/\\/g, "\\\\")}]` : `[${inner.replace(/\\/g, "\\\\")}]`;
        index = close;
      }
    } else if (char === "{") {
      const close = closingBrace(glob, index);
      if (close < 0) {
        out += "\\{";
        continue;
      }
      const body = glob.slice(index + 1, close);
      const range = /^(-?\d+)\.\.(-?\d+)$/.exec(body);
      if (range) {
        const low = Math.min(Number(range[1]), Number(range[2]));
        const high = Math.max(Number(range[1]), Number(range[2]));
        const numbers: string[] = [];
        for (let number = low; number <= high && numbers.length <= 1000; number += 1) numbers.push(String(number));
        out += `(?:${numbers.join("|")})`;
      } else {
        const alternatives = splitAlternatives(body);
        // `{single}` is literal, as in the spec.
        out += alternatives.length === 1 ? `\\{${globBody(body)}\\}` : `(?:${alternatives.map(globBody).join("|")})`;
      }
      index = close;
    } else {
      out += escapeRegex(char);
    }
  }
  return out;
}

/**
 * Whether a section glob matches `relativePath` (the edited file relative to the `.editorconfig`'s
 * folder, `/`-separated). A glob without a slash matches the file name in any folder.
 */
export function editorConfigGlobMatches(glob: string, relativePath: string): boolean {
  let pattern = glob;
  if (!pattern.includes("/")) pattern = `**/${pattern}`;
  else if (pattern.startsWith("/")) pattern = pattern.slice(1);
  try {
    return new RegExp(`^${globBody(pattern)}$`).test(relativePath);
  } catch {
    return false;
  }
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return number > 0 && number <= 32 ? number : undefined;
}

function bool(value: string | undefined): boolean | undefined {
  return value === "true" ? true : value === "false" ? false : undefined;
}

/**
 * The rules for `filePath` from the `.editorconfig` files that reach it, given closest first as
 * `{ dir, text }`. Only the ones up to the first `root = true` count.
 */
export function resolveEditorConfig(filePath: string, files: ReadonlyArray<{ dir: string; text: string }>): EditorConfig | null {
  const normalized = filePath.replace(/\\/g, "/");
  const chain: Array<{ dir: string; parsed: ParsedEditorConfig }> = [];
  for (const file of files) {
    const parsed = parseEditorConfig(file.text);
    chain.push({ dir: file.dir.replace(/\\/g, "/").replace(/\/+$/, ""), parsed });
    if (parsed.root) break;
  }
  const properties: Record<string, string> = {};
  // Farthest first, so closer files and later sections overwrite.
  for (const { dir, parsed } of chain.reverse()) {
    const prefix = `${dir}/`;
    if (!normalized.startsWith(prefix)) continue;
    const relative = normalized.slice(prefix.length);
    for (const section of parsed.sections) {
      if (editorConfigGlobMatches(section.glob, relative)) Object.assign(properties, section.properties);
    }
  }
  const config: EditorConfig = {};
  const style = properties.indent_style;
  if (style === "space" || style === "tab") config.indentStyle = style;
  const tabWidth = positiveInt(properties.tab_width);
  const indentSize = properties.indent_size === "tab" ? tabWidth : positiveInt(properties.indent_size);
  if (indentSize !== undefined) config.indentSize = indentSize;
  // tab_width defaults to indent_size, as the spec says.
  if (tabWidth !== undefined) config.tabWidth = tabWidth;
  else if (indentSize !== undefined) config.tabWidth = indentSize;
  if (properties.end_of_line === "lf") config.endOfLine = "LF";
  else if (properties.end_of_line === "crlf") config.endOfLine = "CRLF";
  const trim = bool(properties.trim_trailing_whitespace);
  if (trim !== undefined) config.trimTrailingWhitespace = trim;
  const finalNewline = bool(properties.insert_final_newline);
  if (finalNewline !== undefined) config.insertFinalNewline = finalNewline;
  return Object.keys(config).length > 0 ? config : null;
}

/** The folders a `.editorconfig` may sit in for `filePath`, closest first. */
export function editorConfigFolders(filePath: string): string[] {
  const normalized = filePath.replace(/\\/g, "/");
  const folders: string[] = [];
  let dir = normalized.slice(0, normalized.lastIndexOf("/"));
  while (folders.length < 32) {
    folders.push(dir || "/");
    if (!dir || dir === "/" || /^[A-Za-z]:$/.test(dir)) break;
    dir = dir.slice(0, dir.lastIndexOf("/"));
  }
  return folders;
}

const CACHE_MS = 5000;
const cache = new Map<string, { at: number; text: Promise<string | null> }>();

/** Forgets read `.editorconfig` files, so an edit to one applies at once. */
export function clearEditorConfigCache(): void {
  cache.clear();
}

/**
 * Reads the `.editorconfig` files for `filePath` with `readText` (null when there is none) and
 * resolves them. All folders are asked at once (one round trip's wait over SSH, not one per
 * folder), and reads are cached for a few seconds: every tab switch asks again.
 */
export async function loadEditorConfig(
  filePath: string,
  readText: (path: string) => Promise<string | null>,
  now: () => number = Date.now,
): Promise<EditorConfig | null> {
  const folders = editorConfigFolders(filePath).map((dir) => (dir === "/" ? "" : dir));
  const texts = await Promise.all(folders.map((dir) => {
    const configPath = `${dir}/.editorconfig`;
    let entry = cache.get(configPath);
    if (!entry || now() - entry.at > CACHE_MS) {
      entry = { at: now(), text: readText(configPath).catch(() => null) };
      cache.set(configPath, entry);
    }
    return entry.text;
  }));
  const files: Array<{ dir: string; text: string }> = [];
  folders.forEach((dir, index) => {
    const text = texts[index];
    if (text !== null) files.push({ dir, text });
  });
  // resolveEditorConfig stops at the first `root = true`.
  return files.length > 0 ? resolveEditorConfig(filePath, files) : null;
}

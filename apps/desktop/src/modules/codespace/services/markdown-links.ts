/*
 * Where a link or image in a Markdown file points on disk. As GitHub and VS Code read them: a
 * relative path from the file's folder, a path starting with `/` from the workspace root.
 */

/** `null` for a link that leaves the disk: a scheme (`https:`, `data:`, `mailto:`), `//host`, `#anchor`. */
export function resolveMarkdownPath(target: string, filePath: string, rootDir?: string | null): string | null {
  const trimmed = target.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  let pathPart = trimmed.replace(/[?#].*$/, "");
  try {
    pathPart = decodeURI(pathPart);
  } catch {
    // A stray % stays as written.
  }
  if (!pathPart) return null;
  const root = rootDir?.replace(/\/+$/, "") ?? "";
  const base = pathPart.startsWith("/")
    ? root
    : filePath.slice(0, filePath.lastIndexOf("/"));
  const parts: string[] = [];
  for (const segment of `${base}/${pathPart}`.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

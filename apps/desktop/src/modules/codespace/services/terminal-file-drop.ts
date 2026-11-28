import { getUiZoom } from "@/lib/ui-zoom";
import { isWindowsPlatform, readPlatformString } from "@/lib/platform";

export const SSH_CONFIRM_THRESHOLD_BYTES = 25 * 1024 * 1024;
export const SSH_HARD_LIMIT_BYTES = 250 * 1024 * 1024;

export type TerminalDropQuoteMode = "posix" | "powershell" | "cmd";

export type InspectedDropPath = {
  path: string;
  name: string;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
};

export type DropInspectionResult = {
  accepted: InspectedDropPath[];
  rejected: Array<{ path: string; reason: string }>;
  totalBytes: number;
};

export type SshUploadPolicy =
  | { kind: "allow" }
  | { kind: "confirm" }
  | { kind: "reject"; reason: string };

export type DropPoint = { x: number; y: number };

function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function quoteDroppedPath(path: string, mode: TerminalDropQuoteMode): string {
  if (mode === "cmd") {
    return `"${path.replace(/(["^%])/g, "^$1")}"`;
  }
  if (mode === "powershell") {
    return `'${path.replace(/'/g, "''")}'`;
  }
  return path.replace(/([\s'"`$\\&;()|<>*?![\]{}])/g, "\\$1");
}

export function quoteModeForPlatform(platform: string = readPlatformString()): TerminalDropQuoteMode {
  return isWindowsPlatform(platform) ? "powershell" : "posix";
}

export function assembleDroppedPathPrompt(paths: readonly string[], mode: TerminalDropQuoteMode): string {
  if (paths.length === 0) return "";
  return `${paths.map((path) => quoteDroppedPath(path, mode)).join(" ")} `;
}

export function classifyDropInspection(entries: readonly InspectedDropPath[]): DropInspectionResult {
  const accepted: InspectedDropPath[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];
  const seenPaths = new Set<string>();
  let totalBytes = 0;

  for (const entry of entries) {
    if (seenPaths.has(entry.path)) continue;
    seenPaths.add(entry.path);

    if (entry.isDirectory) {
      rejected.push({ path: entry.path, reason: "Folder drops are not supported yet." });
      continue;
    }
    if (!entry.isFile) {
      rejected.push({ path: entry.path, reason: "Only regular files can be dropped into a terminal." });
      continue;
    }
    accepted.push(entry);
    totalBytes += entry.size;
  }

  return { accepted, rejected, totalBytes };
}

export function sshUploadPolicy(totalBytes: number): SshUploadPolicy {
  if (totalBytes > SSH_HARD_LIMIT_BYTES) {
    return { kind: "reject", reason: "SSH file drops are limited to 250 MB per batch." };
  }
  if (totalBytes > SSH_CONFIRM_THRESHOLD_BYTES) {
    return { kind: "confirm" };
  }
  return { kind: "allow" };
}

export function inspectNativeDropPath(path: string, info: { isFile: boolean; isDirectory: boolean; size: number }): InspectedDropPath {
  return { path, name: baseName(path), size: info.size, isFile: info.isFile, isDirectory: info.isDirectory };
}

export function dragDropHitTestPoints(position: DropPoint, scaleFactor: number, uiZoom = getUiZoom()): DropPoint[] {
  // The native position is in window points (or pixels); the page is zoomed by Interface size.
  const zoom = Number.isFinite(uiZoom) && uiZoom > 0 ? uiZoom : 1;
  const raw = { x: position.x / zoom, y: position.y / zoom };
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0 || scaleFactor === 1) return [raw];
  const scaled = { x: raw.x / scaleFactor, y: raw.y / scaleFactor };
  if (Math.abs(scaled.x - raw.x) < 0.5 && Math.abs(scaled.y - raw.y) < 0.5) return [raw];
  return [raw, scaled];
}

const SUPPORTED_EXTERNAL_LINK_SCHEMES = ["http:", "https:", "mailto:", "tel:"] as const;
const LOCALHOST_PREFIX_RE = /^(localhost|127(?:\.\d{1,3}){3})(:\d+)?(\/[^\s]*)?$/i;
const PATH_REFERENCE_RE =
  /^((?:~\/|\.{1,2}\/|\/)[^\s:]+|(?:[^/\s:]+\/)+[^:\s]+|[^/\s:]+\.[^:\s]+)(?::(\d+))?(?::(\d+))?$/;
const TOKEN_RE = /\S+/g;
const LEADING_TRIM_RE = /^[([{"'`]+/;
const TRAILING_TRIM_RE = /[)\]}",'`!?;]+$/;

export interface TerminalPathReference {
  path: string;
  line?: number;
  column?: number;
  text: string;
}

export type TerminalDetectedLink =
  | { kind: "external"; text: string; start: number; end: number; url: string }
  | { kind: "path"; text: string; start: number; end: number; path: string; line?: number; column?: number };

export const TERMINAL_LINK_REGEX =
  /(?:https?:\/\/[^\s"'!*(){}|\\^<>`]+[^\s"':,.!?{}|\\^~\[\]`()<>])|(?:mailto:[^\s<>"']+@[^\s<>"']+\.[^\s<>"']+)|(?:tel:\+?[0-9][0-9(). \-]{2,}[0-9])/i;

export function normalizeTerminalLink(uri: string): string | null {
  const trimmed = uri.trim();
  if (!trimmed) return null;

  const localhostMatch = trimmed.match(LOCALHOST_PREFIX_RE);
  if (localhostMatch) {
    const port = localhostMatch[2] ?? "";
    const pathname = localhostMatch[3] ?? "/";
    return `http://${localhostMatch[1]}${port}${pathname}`;
  }

  try {
    const url = new URL(trimmed);
    return SUPPORTED_EXTERNAL_LINK_SCHEMES.includes(url.protocol as typeof SUPPORTED_EXTERNAL_LINK_SCHEMES[number])
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function parseTerminalPathReference(text: string): TerminalPathReference | null {
  const trimmed = text.trim();
  if (!trimmed || normalizeTerminalLink(trimmed)) return null;

  const match = trimmed.match(PATH_REFERENCE_RE);
  const path = match?.[1];
  if (!path) return null;

  const line = match[2] ? Number.parseInt(match[2], 10) : undefined;
  const column = match[3] ? Number.parseInt(match[3], 10) : undefined;

  return {
    path,
    line,
    column,
    text: trimmed,
  };
}

export function detectTerminalLinksInLine(line: string): TerminalDetectedLink[] {
  const matches: TerminalDetectedLink[] = [];

  for (const tokenMatch of line.matchAll(TOKEN_RE)) {
    const raw = tokenMatch[0];
    const rawStart = tokenMatch.index ?? 0;
    const leadingTrim = raw.match(LEADING_TRIM_RE)?.[0].length ?? 0;
    const trailingTrim = raw.match(TRAILING_TRIM_RE)?.[0].length ?? 0;
    const candidate = raw.slice(leadingTrim, raw.length - trailingTrim || undefined);
    if (!candidate) continue;

    const url = normalizeTerminalLink(candidate);
    if (url) {
      matches.push({
        kind: "external",
        text: candidate,
        start: rawStart + leadingTrim,
        end: rawStart + leadingTrim + candidate.length,
        url,
      });
      continue;
    }

    const pathRef = parseTerminalPathReference(candidate);
    if (pathRef) {
      matches.push({
        kind: "path",
        text: pathRef.text,
        start: rawStart + leadingTrim,
        end: rawStart + leadingTrim + candidate.length,
        path: pathRef.path,
        line: pathRef.line,
        column: pathRef.column,
      });
    }
  }

  return matches;
}

/** Pointer travel (px) between press and release beyond which a link click counts as a drag. */
const LINK_CLICK_MAX_TRAVEL = 4;

/**
 * xterm's Linkifier calls `activate` on ANY mouseup that lands on the link it was pressed on —
 * right button, a drag-select that starts and ends inside the link, the clicks of a double-click.
 * This guard admits only a plain, single, stationary primary-button click with no text selected.
 */
export function createTerminalLinkClickGuard(element: HTMLElement | undefined, hasSelection?: () => boolean) {
  let down: { x: number; y: number } | null = null;
  const onMouseDown = (event: MouseEvent) => {
    down = { x: event.clientX, y: event.clientY };
  };
  // Capture phase: recorded before xterm's own mousedown handlers can stop the event.
  element?.addEventListener("mousedown", onMouseDown, true);
  return {
    allows(event: MouseEvent): boolean {
      const start = down;
      down = null;
      if (event.button !== 0 || event.ctrlKey || event.altKey || event.shiftKey) return false;
      if (event.detail > 1) return false;
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > LINK_CLICK_MAX_TRAVEL) return false;
      return !hasSelection?.();
    },
    dispose() {
      element?.removeEventListener("mousedown", onMouseDown, true);
    },
  };
}

"use client";

import { useEffect, useState } from "react";
import { gitBlameFile, type GitBlameEntry } from "@/lib/tauri/project-files";
import { BLAME_MAX_LINES } from "@/modules/codespace/services/inline-blame";

/** Saves come in bursts while an agent writes; blame once they settle. */
const SETTLE_MS = 400;

/**
 * Who last changed each line of the shown file (mockups/inline-blame.html).
 *
 * Read when the file opens and again whenever its saved text changes (a save, or an agent's write
 * picked up from disk). `null` (no blame, no message) when off, on SSH, outside git, or past
 * BLAME_MAX_LINES.
 */
export function useInlineBlame({
  on,
  rootDir,
  filePath,
  savedText,
}: {
  on: boolean;
  rootDir: string;
  filePath: string | null;
  /** The file as it is on disk; `null` until it is read. */
  savedText: string | null;
}): { path: string; entries: GitBlameEntry[] } | null {
  const [blame, setBlame] = useState<{ path: string; entries: GitBlameEntry[] } | null>(null);
  const relative = filePath?.startsWith(`${rootDir}/`) ? filePath.slice(rootDir.length + 1) : null;
  const lines = savedText === null ? 0 : savedText.split("\n").length;
  const wanted = on && filePath !== null && relative !== null && savedText !== null && lines <= BLAME_MAX_LINES;

  useEffect(() => {
    if (!wanted || !filePath || !relative) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      gitBlameFile(rootDir, relative).then(
        (entries) => !cancelled && setBlame({ path: filePath, entries }),
        // Not in git, untracked, or git missing: no blame, and nothing to say about it.
        () => !cancelled && setBlame(null),
      );
    }, SETTLE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [filePath, relative, rootDir, savedText, wanted]);

  return wanted && blame?.path === filePath ? blame : null;
}

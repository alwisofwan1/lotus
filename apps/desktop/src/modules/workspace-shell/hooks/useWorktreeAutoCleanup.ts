"use client";

import { useEffect } from "react";
import { getSettings } from "@/lib/tauri-api";
import { isTauri } from "@/lib/tauri/runtime";
import { autoCleanWorktrees, readWorktreeCleanupSettings } from "@/lib/tauri/worktree-cleanup";

/** Late enough that the panes of a restored session are open (and so count as in use) first. */
const FIRST_RUN_MS = 2 * 60_000;
const EVERY_MS = 30 * 60_000;

/**
 * Settings › Worktrees › Clean up automatically (off by default). Rust picks and re-checks the rows;
 * this only decides when, reading the setting fresh each time so a change needs no restart.
 */
export function useWorktreeAutoCleanup(): void {
  useEffect(() => {
    if (!isTauri()) return;
    const run = async () => {
      try {
        const rule = readWorktreeCleanupSettings(await getSettings());
        if (!rule.auto) return;
        const results = await autoCleanWorktrees(rule.days);
        for (const r of results) {
          if (r.error) console.warn(`[worktree-cleanup] kept ${r.path}: ${r.error}`);
        }
      } catch (error) {
        console.warn("[worktree-cleanup] auto rule skipped:", error);
      }
    };
    const first = setTimeout(() => void run(), FIRST_RUN_MS);
    const every = setInterval(() => void run(), EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, []);
}

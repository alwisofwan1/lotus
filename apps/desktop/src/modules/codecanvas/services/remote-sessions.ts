import {
  listClaudeSessions,
  listClaudeSessionsSsh,
  readClaudeSessionTail,
  readClaudeSessionTailSsh,
} from "@/lib/tauri-api";
import { wireTarget, type Machine } from "./machine";

/**
 * Reading a runner's own transcripts, on whichever machine they live.
 *
 * **What changes for a remote project is only where the directory is.** The slug a cwd maps to, the
 * newest-first ordering, the dedupe across profile roots, the "walk backwards for the newest
 * assistant line" — all of that is the same logic and, in Rust, literally the same functions. Two
 * implementations of *that* would drift the first time Claude's transcript format moved, on one
 * machine only.
 *
 * These two dispatchers exist so no caller has to remember which machine it is on.
 */

/** Transcript ids for `cwd`, newest first. Empty is "none recorded", never "could not look". */
export async function claudeSessionsFor(
  location: Machine | null | undefined,
  cwd: string,
): Promise<string[]> {
  if (!location) return listClaudeSessions(cwd);
  return listClaudeSessionsSsh(wireTarget(location), cwd);
}

/** The newest assistant line of one transcript, or null when there is no such transcript. */
export async function claudeSessionTailFor(
  location: Machine | null | undefined,
  cwd: string,
  sessionId: string,
  maxChars = 240,
): Promise<string | null> {
  if (!location) return readClaudeSessionTail(cwd, sessionId, maxChars);
  return readClaudeSessionTailSsh(wireTarget(location), cwd, sessionId, maxChars);
}

// Drop-file shape and atomic writer. The schema produced here is the v1
// contract documented in plans/agent-hooks/drop-file-schema.md.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PAYLOAD_VERSION = 1;

// Caps mirror the schema doc. Truncation is hard (no ellipsis byte) so that
// the watcher can defensively re-clamp without ambiguity.
const TITLE_MAX = 200;
// Raised from 1000 on 2026-08-07, from counting rather than taste: across 279 real
// assistant messages, 15.8% exceeded 1000 characters — about one reply in six was
// being cut mid-word — and 8000 covers 97.1%. Whatever still gets cut now says so
// via `bodyTruncated`. Keep in lockstep with `BODY_MAX` in `agent_hooks/payload.rs`.
const BODY_MAX = 8000;
const USER_PROMPT_MAX = 4000;
const TOOL_TARGET_MAX = 300;
// Same ceiling `cwd` gets on the Rust side: both are filesystem paths, and a path longer
// than this is a sign something is wrong rather than a session worth pointing at.
const TRANSCRIPT_PATH_MAX = 4096;

const DEFAULT_SLUG_MAX = 32;
const SAFE_SLUG_RE = /[^a-z0-9-]/gi;

/**
 * Default drop directory: `~/.lotus/agent-hooks/global/`. Override by passing
 * an explicit dir to the writer (used in tests).
 *
 * @returns {string}
 */
export function defaultDropDir() {
  return path.join(os.homedir(), ".lotus", "agent-hooks", "global");
}

/**
 * Where to write, preferring `--drop-dir` from the parent.
 *
 * The parent has to say, because this script cannot know: the same file is
 * installed to `~/.lotus/agent-notify/` by a release build and to
 * `~/.lotus-dev/agent-notify/` by a dev build, and a hardcoded default made both
 * copies write to the release directory. Two desktops then raced for every hook
 * event, and whichever watcher won it, the other never saw it.
 *
 * @param {Record<string, string>} args
 * @returns {string}
 */
export function resolveDropDir(args) {
  const flag = typeof args?.["drop-dir"] === "string" ? args["drop-dir"].trim() : "";
  // Relative is refused, not resolved: a hook runs with the agent's cwd, which is
  // whatever repo the operator happened to be in.
  return flag.length > 0 && path.isAbsolute(flag) ? flag : defaultDropDir();
}

/**
 * Slugify a value for use in filenames. Drops anything outside [a-z0-9-],
 * truncates to `max`, and returns `"unknown"` if the result would be empty.
 *
 * @param {unknown} input
 * @param {number} [max]
 * @returns {string}
 */
export function slug(input, max = DEFAULT_SLUG_MAX) {
  const cap = typeof max === "number" && max > 0 ? max : DEFAULT_SLUG_MAX;
  const cleaned = String(input ?? "").replace(SAFE_SLUG_RE, "").slice(0, cap);
  return cleaned || "unknown";
}

/**
 * Hard-truncate a string to `max` chars. Coerces non-string input.
 *
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function truncate(value, max) {
  const str = value == null ? "" : String(value);
  return str.length > max ? str.slice(0, max) : str;
}

/**
 * Whether `truncate(value, max)` would actually remove anything.
 *
 * Separate from `truncate` so that function keeps its one job and its callers keep
 * reading as a list of caps. Only `body` asks — a clipped `cwd` is cosmetic, a
 * clipped assistant message is a sentence that stops mid-word.
 *
 * @param {unknown} value
 * @param {number} max
 * @returns {boolean}
 */
export function wouldTruncate(value, max) {
  return (value == null ? "" : String(value)).length > max;
}

/**
 * Build the v1 drop payload object. Pure — does not touch the filesystem.
 *
 * @param {{
 *   sessionId?: string | null,
 *   agent: string,
 *   event: string,
 *   status: string,
 *   title?: string,
 *   body?: string,
 *   userPrompt?: string,
 *   toolTarget?: string,
 *   linesAdded?: number | null,
 *   linesRemoved?: number | null,
 *   cwd?: string,
 *   transcriptPath?: string,
 *   pid?: number | null,
 *   agentPid?: number | null,
 *   timestamp: number,
 * }} fields
 */
export function buildDropPayload(fields) {
  return {
    version: PAYLOAD_VERSION,
    sessionId: typeof fields.sessionId === "string" && fields.sessionId
      ? fields.sessionId
      : null,
    agentType: fields.agent,
    event: fields.event,
    status: fields.status,
    title: truncate(fields.title ?? "", TITLE_MAX),
    body: truncate(fields.body ?? "", BODY_MAX),
    // Additive like `toolTarget` below, so the version stays 1. A flag rather than
    // an appended "…": the cap is applied twice (here, then defensively in
    // `agent_hooks/payload.rs`), and that second pass is only safe because
    // truncation is idempotent. An ellipsis byte would break that property; a
    // boolean the consumer can OR into its own result does not.
    bodyTruncated: wouldTruncate(fields.body ?? "", BODY_MAX),
    userPrompt: truncate(fields.userPrompt ?? "", USER_PROMPT_MAX),
    // Additive, so the version stays 1: the Rust consumer sets no
    // `deny_unknown_fields`, which makes new-producer/old-consumer a no-op and
    // old-producer/new-consumer a default. A bump would break both directions.
    toolTarget: truncate(fields.toolTarget ?? "", TOOL_TARGET_MAX),
    // Two integers rather than a formatted "+3 -1": the phone renders the minus
    // as U+2212, and a pre-formatted ASCII string would have to be parsed back.
    linesAdded: nonNegativeIntOrNull(fields.linesAdded),
    linesRemoved: nonNegativeIntOrNull(fields.linesRemoved),
    // Where the agent CLI keeps its own conversation. Additive like `toolTarget`, so the
    // version stays 1. A property of the session rather than of this event — every event
    // in a session carries the same path — but sent on each drop anyway, because the
    // consumer has nowhere else to learn it and a hook fires without any handshake first.
    transcriptPath: truncate(
      typeof fields.transcriptPath === "string" ? fields.transcriptPath : "",
      TRANSCRIPT_PATH_MAX,
    ),
    cwd: typeof fields.cwd === "string" ? fields.cwd : "",
    pid: typeof fields.pid === "number" ? fields.pid : null,
    agentPid: typeof fields.agentPid === "number" ? fields.agentPid : null,
    // Canvas pane correlation (LOTUS_PANE_ID) — null for codespace terminals / external CLIs.
    paneId: typeof fields.paneId === "string" && fields.paneId ? fields.paneId : null,
    timestamp: fields.timestamp,
  };
}

/**
 * Build the filename `<sessionIdSlug>--<ts>-<agent>-<event>-<rand>.json`.
 *
 * @param {{
 *   sessionId: string | null,
 *   agent: string,
 *   event: string,
 *   timestamp: number,
 *   randomSuffix: string,
 *   pid: number | null,
 * }} fields
 * @returns {string}
 */
export function buildDropFilename(fields) {
  const sidPart = fields.sessionId
    ? slug(fields.sessionId, 48)
    : `nosession-${slug(String(fields.pid ?? "0"), 12)}`;
  const ts = fields.timestamp;
  const agentPart = slug(fields.agent, 16);
  const eventPart = slug(fields.event, 24);
  const rand = slug(fields.randomSuffix, 12);
  return `${sidPart}--${ts}-${agentPart}-${eventPart}-${rand}.json`;
}

/**
 * Count files in `dir`, stopping early once `limit` is reached. Used by the
 * caller's directory size guard. Returns 0 when the dir does not exist.
 *
 * @param {string} dir
 * @param {number} limit
 * @returns {number}
 */
export function countFilesAtMost(dir, limit) {
  let handle;
  try {
    handle = fs.opendirSync(dir);
  } catch {
    return 0;
  }
  let count = 0;
  try {
    while (count < limit) {
      const entry = handle.readSync();
      if (!entry) break;
      if (entry.isFile()) count += 1;
    }
  } finally {
    try {
      handle.closeSync();
    } catch {
      // Already closed.
    }
  }
  return count;
}

/**
 * Atomically write `payload` (JSON-stringified) to `target`. Stages to a
 * sibling `.tmp` file then renames. On Windows where `rename` may fail with
 * EEXIST/EPERM/EACCES on existing target, falls back to unlink+rename, then
 * to copy+unlink. Returns true on success, false on any error — never throws.
 *
 * @param {string} target
 * @param {object} payload
 * @returns {boolean}
 */
export function writeDropFileAtomic(target, payload) {
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return false;
  }

  try {
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true });
  } catch {
    return false;
  }

  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, serialized);
  } catch {
    safeUnlink(tmp);
    return false;
  }

  try {
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    const code = err?.code;
    if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") {
      safeUnlink(tmp);
      return false;
    }
  }

  // Windows fallback path.
  safeUnlink(target);
  try {
    fs.renameSync(tmp, target);
    return true;
  } catch {
    // Fallthrough to copy+unlink.
  }
  try {
    fs.copyFileSync(tmp, target);
    safeUnlink(tmp);
    return true;
  } catch {
    safeUnlink(tmp);
    return false;
  }
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // File may already be gone — ignore.
  }
}

/** Keeps a bad count out of the payload instead of shipping NaN or a negative. */
function nonNegativeIntOrNull(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

// Pure orchestrator for the hook script. Takes injected I/O so it can be
// driven from tests without spawning a subprocess. The CLI entry
// (`index.mjs`) is a thin wrapper that supplies real argv/stdin/fs.

import {
  buildDropFilename,
  buildDropPayload,
  countFilesAtMost,
  writeDropFileAtomic,
} from "./drop-file.mjs";
import { mapEventToStatus } from "./event-mapping.mjs";
import {
  extractBody,
  extractSessionId,
  extractToolName,
  extractToolTarget,
  extractToolDiffStat,
  looksLikeToolFailure,
  extractToolFilePath,
  extractTranscriptPath,
  extractUserPrompt,
  parseJsonSafe,
} from "./payload-extractors.mjs";
import path from "node:path";

/**
 * Soft cap on drop directory size. When exceeded we skip the write rather
 * than block the hook. The watcher's startup drain reclaims space.
 */
export const DROP_DIR_SOFT_CAP = 1000;

/**
 * @typedef {Object} RunHookResult
 * @property {"ok" | "skipped-empty" | "skipped-full" | "skipped-idle" | "write-failed"} outcome
 * @property {string} [filePath]    Set when outcome is "ok".
 * @property {string} [reason]      Optional human-readable detail.
 */

/**
 * Run the hook orchestration once.
 *
 * @param {{
 *   argv: string[],
 *   stdin: string,
 *   env: Record<string, string | undefined>,
 *   args: Record<string, string>,
 *   dropDir: string,
 *   timestamp: number,
 *   randomSuffix: string,
 *   pid: number | null,
 * }} ctx
 * @returns {RunHookResult}
 */
export function runHook(ctx) {
  const { args, env, stdin, dropDir, timestamp, randomSuffix, pid } = ctx;

  const flagged = (args.agent ?? "").toLowerCase().trim() || "unknown";
  // Cursor runs the Claude-format hooks from `~/.claude/settings.json`, whose commands say
  // `--agent claude` because Lotus wrote them for Claude. The hook process can tell:
  // Cursor sets `CURSOR_VERSION` for every hook it spawns (cursor.com/docs/agent/hooks,
  // "always present") and stamps `cursor_version` into the payload. Probe 2026-08-27:
  // `cursor-agent -p` fired PreToolUse/PostToolUse through exactly this path, and the drop
  // filed the step under `claude`. Only the Claude label is corrected — a hook that named
  // another agent on purpose keeps its word.
  const payloadEarly = parseJsonSafe(stdin);
  const ranByCursor =
    Boolean(pickEnv(env, "CURSOR_VERSION")) ||
    (payloadEarly && typeof payloadEarly.cursor_version === "string");
  const agent = flagged === "claude" && ranByCursor ? "cursor" : flagged;
  const rawEvent = (args.event ?? "").toLowerCase().trim() || "stop";

  // Refuse to write phantom drops when both critical fields are missing.
  // Without agent and event, the watcher can't classify or correlate.
  if (agent === "unknown" && !args.event) {
    return { outcome: "skipped-empty", reason: "missing agent and event" };
  }

  const payloadJson = payloadEarly;

  const sessionId =
    pickFlag(args, "session-id") ??
    extractSessionId(payloadJson) ??
    pickEnv(env, "BRIDGESPACE_SESSION_ID") ??
    pickEnv(env, "LOTUS_SESSION_ID") ??
    null;

  // CLI flag wins over stdin payload — used by hosts that can't easily pipe
  // JSON (e.g. shell-template-literal-based hook runners).
  // For tool events `body` is the FILE PATH, not prose: `narration-event.ts` reads
  // it that way to build filesTouched and the per-agent AREA label. The shell hook
  // this replaced smuggled it there, and changing the field would silently empty a
  // working feature.
  // `prompt-submit` is the one event whose body is the operator's words, and the keys it
  // arrives under are deliberately disjoint from BODY_KEYS — `extractBody` would return
  // nothing and the entry would carry no message at all.
  const body =
    pickFlag(args, "body") ??
    (rawEvent === "prompt-submit"
      ? extractUserPrompt(payloadJson)
      : rawEvent.startsWith("tool-")
        ? extractToolFilePath(payloadJson)
        : extractBody(payloadJson));
  const userPrompt = pickFlag(args, "user-prompt") ?? extractUserPrompt(payloadJson);

  // Claude's `Notification` hook fires for two unrelated things: the agent needs
  // permission to run a tool, and the input box has simply been idle for 60 seconds.
  // Only the first means a human is needed, and everything downstream reads
  // `needs-input` as exactly that — the phone's permission card, and the FCM wake-up
  // whose entire rule is `status === "needs-input"`. Left mapped, every reply an agent
  // gives rings a sleeping phone a minute later, and the channel this product exists
  // for becomes the one the operator learns to ignore.
  //
  // Measured against a live host on 2026-08-07: six notifications across one session,
  // every single one exactly 60s after the preceding `stop`, and not one of them a real
  // request.
  //
  // Dropped rather than reclassified, because no consumer wants it under any status:
  // the `stop` a minute earlier already recorded the turn as idle, the transcript ring
  // is bounded so one of these per turn evicts real history, and Chat rendered it as a
  // step line saying what the composer underneath it already says.
  //
  // The test DEMOTES one known string; it must never be inverted into promoting a known
  // permission string. That session contained no real permission request, so its exact
  // wording is something this repo has not observed — and a mismatch has to fail towards
  // alerting. Every notification text that is not this one keeps `needs-input`.
  //
  // Claude 2.1.329 types its notifications (14 types); when typed, only the asking ones count.
  if (rawEvent === "notification" && !asksTheOperator(payloadJson, body)) {
    return { outcome: "skipped-idle", reason: "notification only informs" };
  }

  // A failing tool rides the EVENT NAME, never the status: codespace's
  // `useAgentHookEvents` filters on status alone and reads `error` as "the agent
  // failed", which would mislabel the whole agent over one bad tool call.
  const event = rawEvent === "tool-post" && looksLikeToolFailure(payloadJson)
    ? "tool-post-failed"
    : rawEvent;

  const { status, defaultTitle } = mapEventToStatus(event);
  // Narration tool events carry the tool name as the title — that is how the consumer derives a
  // routing tag without a schema change. Scoped to tool events on purpose: a Stop hook's stdin can
  // still mention the last tool call, and letting that win would retitle the turn-end drop.
  const isToolEvent = rawEvent.startsWith("tool-");
  const toolName = isToolEvent ? extractToolName(payloadJson) : "";
  // Scoped to tool events for the same reason the title is: a Stop hook's stdin
  // can still mention the last tool call, and letting that through would attach
  // a stale argument to a turn-end drop.
  const toolTarget = isToolEvent ? extractToolTarget(payloadJson) : "";
  // Only PostToolUse carries a result; a pre-event has nothing to count yet.
  const diff = rawEvent === "tool-post" ? extractToolDiffStat(payloadJson) : null;
  const title = pickFlag(args, "title") ?? (toolName || defaultTitle);

  const agentPidFromEnv = parseIntOrNull(pickEnv(env, "LOTUS_AGENT_PID"));
  // Canvas PTY shells export LOTUS_PANE_ID; the agent CLI (and this hook) inherit it. It is the
  // only unambiguous correlation key for canvas agents — several share one project cwd.
  const paneId = pickEnv(env, "LOTUS_PANE_ID");

  const payload = buildDropPayload({
    sessionId,
    agent,
    event,
    status,
    title,
    body,
    userPrompt,
    toolTarget,
    linesAdded: diff?.added ?? null,
    linesRemoved: diff?.removed ?? null,
    // Flag wins over stdin for the same reason `sessionId` does: a shell-template hook
    // runner cannot pipe JSON, and this is the one field a wrapper might know when the
    // payload does not.
    transcriptPath:
      pickFlag(args, "transcript-path") ?? extractTranscriptPath(payloadJson),
    cwd: ctx.cwd ?? "",
    pid,
    agentPid: agentPidFromEnv,
    paneId,
    timestamp,
  });

  // Size guard: skip writes when the dir is already past its soft cap.
  // Counting stops at the cap so this stays O(cap) in the worst case.
  if (countFilesAtMost(dropDir, DROP_DIR_SOFT_CAP) >= DROP_DIR_SOFT_CAP) {
    return { outcome: "skipped-full", reason: "drop directory full" };
  }

  const filename = buildDropFilename({
    sessionId,
    agent,
    event,
    timestamp,
    randomSuffix,
    pid,
  });
  const filePath = path.join(dropDir, filename);

  const wrote = writeDropFileAtomic(filePath, payload);
  if (!wrote) return { outcome: "write-failed", reason: "writeDropFileAtomic returned false" };

  return { outcome: "ok", filePath };
}

/**
 * Claude Code's idle-timer notification, verbatim.
 *
 * An exact match on the whole trimmed message, not a substring search: "waiting for
 * your input" is a phrase a real prompt could plausibly contain, and a loose pattern
 * here would silently swallow the one event worth waking a phone for. Case is folded
 * because that costs nothing; the wording is not guessed at beyond that.
 *
 * Codex never reaches this branch — `codex-notify.sh` posts to `/v1/hook/stop` and
 * never invokes this script with `--event notification` — so the check needs no
 * per-agent scoping to stay off other runners.
 *
 * @param {string} message
 * @returns {boolean}
 */
function isIdleTimeoutNotice(message) {
  return typeof message === "string"
    && message.trim().toLowerCase() === "claude is waiting for your input";
}

/** Claude notification types that wait on this pane's operator; the other types only inform. */
const ASKING_TYPES = new Set(["permission_prompt", "worker_permission_prompt", "elicitation_dialog", "elicitation_url_dialog"]);

/**
 * @param {unknown} payload
 * @param {string | null} message
 * @returns {boolean}
 */
function asksTheOperator(payload, message) {
  const type = payload && typeof payload === "object" ? payload.notification_type : undefined;
  if (typeof type === "string") return ASKING_TYPES.has(type);
  return !isIdleTimeoutNotice(message);
}

function pickFlag(args, key) {
  const v = args?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function pickEnv(env, key) {
  const v = env?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function parseIntOrNull(value) {
  if (typeof value !== "string" || !value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

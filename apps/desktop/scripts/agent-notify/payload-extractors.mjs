// Shape-tolerant extractors for the JSON payloads agent CLIs send to hooks.
// Each agent (Claude, Codex, Cursor, OpenCode) has a slightly different schema;
// these functions accept whatever lands and pull the fields we care about.

const BODY_KEYS = ["last_assistant_message", "lastAssistantMessage", "message", "body", "text"];

// Note: deliberately disjoint from BODY_KEYS. The original BridgeSpace script
// shared `text`/`message` between body and prompt extraction, which caused
// duplicated content. We treat body and userPrompt as separate concerns.
const PROMPT_KEYS = ["prompt", "user_prompt", "userPrompt", "user_message", "userMessage", "input", "query"];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimmedString(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed;
}

/**
 * Parse a JSON string; return null on any error or non-string input.
 * @param {unknown} raw
 * @returns {object | null}
 */
export function parseJsonSafe(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Pull the agent CLI session id out of a payload. Recognizes Claude
 * (`session_id`), camelCase (`sessionId`), and Codex (`session.id`).
 *
 * @param {unknown} payload
 * @returns {string | null}
 */
export function extractSessionId(payload) {
  if (!isPlainObject(payload)) return null;
  if (typeof payload.session_id === "string" && payload.session_id) {
    return payload.session_id;
  }
  if (typeof payload.sessionId === "string" && payload.sessionId) {
    return payload.sessionId;
  }
  if (
    isPlainObject(payload.session) &&
    typeof payload.session.id === "string" &&
    payload.session.id
  ) {
    return payload.session.id;
  }
  // Cursor: every hook carries `conversation_id` (cursor.com/docs/agent/hooks) and nothing
  // named `session_id`. It plays the same role — one id per conversation, the one the
  // transcript file is named after — so it lands in the same field.
  if (typeof payload.conversation_id === "string" && payload.conversation_id) {
    return payload.conversation_id;
  }
  return null;
}

/**
 * Pull a human-readable body (assistant's last message) from a payload.
 * Returns "" when no body field is present.
 *
 * @param {unknown} payload
 * @returns {string}
 */
export function extractBody(payload) {
  if (!isPlainObject(payload)) return "";
  for (const key of BODY_KEYS) {
    const value = trimmedString(payload[key]);
    if (value) return value;
  }
  return "";
}

/**
 * Absolute path of the agent CLI's own conversation transcript, when the hook says.
 *
 * Both Claude and Codex hand this over on every event (`transcript_path`), and it is the
 * only pointer Lotus gets to a history that is durable, complete, and not clamped by
 * `BODY_MAX` — the drop pipeline is a ring of hook events, that file is the conversation.
 * Fase 0 measured 11.7% of entries falling out of the 60-entry ring and 14 restarts each
 * starting Chat empty; both stop mattering once a reader can reach this.
 *
 * @param {unknown} payload
 * @returns {string}
 */
export function extractTranscriptPath(payload) {
  if (!isPlainObject(payload)) return "";
  for (const key of ["transcript_path", "transcriptPath"]) {
    const value = trimmedString(payload[key]);
    if (value) return value;
  }
  return "";
}

/**
 * Pull the user's prompt out of a payload. Searches top-level prompt-y keys,
 * then walks `input_messages` from the end (Codex shape), then recurses one
 * level into `params` (Cursor shape).
 *
 * @param {unknown} payload
 * @returns {string}
 */
export function extractUserPrompt(payload) {
  if (!isPlainObject(payload)) return "";

  for (const key of PROMPT_KEYS) {
    const value = trimmedString(payload[key]);
    if (value) return value;
  }

  const messages = payload.input_messages ?? payload.inputMessages;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const msg = messages[i];
      if (typeof msg === "string") {
        const trimmed = trimmedString(msg);
        if (trimmed) return trimmed;
        continue;
      }
      if (isPlainObject(msg)) {
        const candidate = msg.content ?? msg.text ?? msg.message;
        const trimmed = trimmedString(candidate);
        if (trimmed) return trimmed;
      }
    }
  }

  if (isPlainObject(payload.params)) {
    const nested = extractUserPrompt(payload.params);
    if (nested) return nested;
  }

  return "";
}

/**
 * Pull the tool name out of a tool-hook payload (`PreToolUse` / `PostToolUse`).
 *
 * Used as the drop payload's `title` for narration tool events, so the consumer can derive a
 * routing tag (`tool_edit`, `tool_bash`) without a schema change. Returns `""` when the payload
 * carries no tool, which keeps a non-tool hook on its own default title.
 *
 * @param {unknown} payload
 * @returns {string}
 */
export function extractToolName(payload) {
  if (!isPlainObject(payload)) return "";
  return trimmedString(payload.tool_name) || trimmedString(payload.toolName) || "";
}

// Ordered by which argument an operator would recognise as "what this call is doing".
// `command` and `pattern` outrank `path`: a Grep sends both, and the pattern is the
// intent while the path is only scope.
const TOOL_TARGET_KEYS = [
  "command",
  "file_path",
  "filePath",
  "notebook_path",
  "notebookPath",
  "pattern",
  "url",
  "description",
  "path",
  "prompt",
];

/** Longest target we keep. The drop file has a budget and the phone has one line. */
const TOOL_TARGET_MAX = 300;

/**
 * Pull the salient argument out of a tool hook's `tool_input`.
 *
 * Without it a step can only say `Bash`, which is a noun; with it the step says
 * `rm src/legacy/shim.ts`, which is something an operator can approve or refuse.
 * A single extracted string rather than the raw object on purpose: the consumer
 * then needs no knowledge of each tool's argument schema.
 *
 * @param {unknown} payload
 * @returns {string}
 */
export function extractToolTarget(payload) {
  if (!isPlainObject(payload)) return "";
  const input = isPlainObject(payload.tool_input)
    ? payload.tool_input
    : isPlainObject(payload.toolInput)
      ? payload.toolInput
      : null;
  if (input === null) return "";

  for (const key of TOOL_TARGET_KEYS) {
    const value = trimmedString(input[key]);
    if (value) return oneLine(value).slice(0, TOOL_TARGET_MAX);
  }
  return "";
}

function oneLine(value) {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Count added/removed lines from a `PostToolUse` payload, or null when the tool
 * changed no lines.
 *
 * Shapes verified by capture against Claude Code 2.1.221, not inferred:
 * `Edit` carries `structuredPatch` hunks whose `lines` are prefixed `+`, `-` or
 * a space; `Write` on a NEW file carries `type: "create"`, a null `originalFile`
 * and an EMPTY `structuredPatch`, so counting hunks alone would report `+0 -0`
 * for a brand new file; `Read` and `Bash` carry no diff at all.
 *
 * @param {unknown} payload
 * @returns {{ added: number, removed: number } | null}
 */
export function extractToolDiffStat(payload) {
  if (!isPlainObject(payload)) return null;
  const response = isPlainObject(payload.tool_response)
    ? payload.tool_response
    : isPlainObject(payload.toolResponse)
      ? payload.toolResponse
      : null;
  if (response === null) return null;

  const patch = response.structuredPatch;
  if (Array.isArray(patch) && patch.length > 0) {
    let added = 0;
    let removed = 0;
    for (const hunk of patch) {
      if (!isPlainObject(hunk) || !Array.isArray(hunk.lines)) return null;
      for (const line of hunk.lines) {
        if (typeof line !== "string") continue;
        if (line.startsWith("+")) added += 1;
        else if (line.startsWith("-")) removed += 1;
      }
    }
    return { added, removed };
  }

  // A creation has no hunks to count, so the content is the only record of size.
  if (response.type === "create" && typeof response.content === "string") {
    return { added: countLines(response.content), removed: 0 };
  }

  return null;
}

/** Lines in a text blob, not counting the trailing newline as one more. */
function countLines(text) {
  if (text.length === 0) return 0;
  const withoutTrailing = text.endsWith("\n") ? text.slice(0, -1) : text;
  return withoutTrailing.split("\n").length;
}

/** Failure markers, scoped to `tool_response` so the tool's own input cannot trip them. */
const FAILURE_KEYS = ["exit_code", "exitCode"];

/**
 * Whether a `PostToolUse` result reads as a failure.
 *
 * Ported from the shell hook this replaced, shapes and all. Worth knowing before
 * trusting it: those shapes came from Heard's `templates.post_tool_event`, not
 * from an observed Claude Code payload, and three capture runs against Claude
 * Code 2.1.221 never produced one — a tool that fails emits **no** `PostToolUse`,
 * so a failure is visible instead as a `tool-pre` with no matching `tool-post`.
 *
 * Kept anyway: carrying an unused branch is cheaper than losing a failure signal,
 * and three observations of mine are not enough to delete someone else's evidence.
 *
 * @param {unknown} payload
 * @returns {boolean}
 */
export function looksLikeToolFailure(payload) {
  if (!isPlainObject(payload)) return false;
  const response = isPlainObject(payload.tool_response)
    ? payload.tool_response
    : isPlainObject(payload.toolResponse)
      ? payload.toolResponse
      : null;
  if (response === null) return false;

  for (const key of FAILURE_KEYS) {
    const value = response[key];
    if (typeof value === "number" && value !== 0) return true;
  }
  if (response.success === false) return true;
  if (response.is_error === true || response.isError === true) return true;
  // Presence, not truthiness: an `error` key at all means the tool reported one.
  // `null` and `""` are excluded so a field that merely EXISTS and is empty
  // (a common "no error" encoding) does not read as a failure.
  if ("error" in response && response.error !== null && response.error !== "") return true;

  return false;
}

/** Keys the shell hook's sed matched, and only those. */
const TOOL_FILE_PATH_KEYS = ["file_path", "filePath", "notebook_path", "notebookPath"];

/**
 * The file a tool touched, or `""` — deliberately narrower than
 * {@link extractToolTarget}.
 *
 * This exists to keep `body` meaning exactly what it meant when the shell hook
 * wrote it: `narration-event.ts` reads `payload.body` as the file path for tool
 * events and feeds it into `filesTouched` and the per-agent AREA label.
 * `extractToolTarget` prefers `command`, so reusing it here would file
 * `rm -rf node_modules` as a path the agent touched.
 *
 * @param {unknown} payload
 * @returns {string}
 */
export function extractToolFilePath(payload) {
  if (!isPlainObject(payload)) return "";
  const input = isPlainObject(payload.tool_input)
    ? payload.tool_input
    : isPlainObject(payload.toolInput)
      ? payload.toolInput
      : null;
  if (input === null) return "";
  for (const key of TOOL_FILE_PATH_KEYS) {
    const value = trimmedString(input[key]);
    if (value) return oneLine(value).slice(0, TOOL_TARGET_MAX);
  }
  return "";
}

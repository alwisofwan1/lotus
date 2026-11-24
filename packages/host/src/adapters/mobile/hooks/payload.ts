/**
 * v1 drop-file payload: parse, validate, defensively re-clamp.
 *
 * A port of `apps/desktop/src-tauri/src/agent_hooks/payload.rs`, against the frozen contract in
 * `plans/agent-hooks/drop-file-schema.md`. The producer — `scripts/agent-notify/` — is the source
 * of truth for field shapes; this side validates so a misbehaving script cannot break the watcher
 * loop or push oversized strings at a phone.
 *
 * Slice 1b.3. A standalone host has no Rust behind it, and this is the half of ADR-8's
 * "two independent signals" that the terminal cannot provide: the hook says a cell is waiting,
 * `permission/prompt.ts` says what it is waiting for, and only both together may draw a chip.
 */

/** The schema version this consumer accepts. Bump in lockstep with the producer. */
export const PAYLOAD_VERSION = 1;

// Caps mirror the schema doc, re-applied here in case the producer was ever bypassed.
const TITLE_MAX = 200;
/**
 * Raised from 1000 on 2026-08-07, and the number came from counting rather than taste: across
 * 279 real assistant messages, 15.8% were longer than 1000 bytes — roughly one reply in six cut
 * mid-word — while 8000 covers 97.1%.
 */
const BODY_MAX = 8000;
const USER_PROMPT_MAX = 4000;
const TOOL_TARGET_MAX = 300;
const CWD_MAX = 4096;
const TRANSCRIPT_PATH_MAX = 4096;
const AGENT_TYPE_MAX = 32;
const EVENT_MAX = 32;
const STATUS_MAX = 16;
const SESSION_ID_MAX = 256;

export interface DropPayload {
  version: number;
  sessionId: string | null;
  agentType: string;
  event: string;
  status: string;
  title: string;
  body: string;
  userPrompt: string;
  /** Salient argument of a tool call (`rm src/legacy/shim.ts`), extracted by the hook script. */
  toolTarget: string;
  /** `undefined` rather than 0: "changed nothing" and "no diff applies here" are different
   * claims, and a `Read` step must not render "+0 -0". */
  linesAdded?: number;
  linesRemoved?: number;
  /** Whether the body cap cut `body` short — a flag rather than an ellipsis byte, because the
   * cap is applied twice and only stays safe while truncation is idempotent. */
  bodyTruncated: boolean;
  /** The agent CLI's own transcript, when the hook reports one. What Fase 3 is built on. */
  transcriptPath: string;
  cwd: string;
  pid: number | null;
  agentPid: number | null;
  /**
   * `LOTUS_PANE_ID`, seeded at spawn (slice 1b.1).
   *
   * **The only unambiguous key on this host.** The schema calls `cwd` the correlation key, and
   * on a desktop that holds; here several cells routinely share one project directory, so cwd
   * alone would hand one cell's approval to another.
   */
  paneId: string | null;
  timestamp: number;
}

export type DropPayloadError =
  | { kind: "json"; message: string }
  | { kind: "unsupported-version"; actual: unknown }
  | { kind: "missing-field"; field: string };

export type DropParseResult =
  | { ok: true; payload: DropPayload }
  | { ok: false; error: DropPayloadError };

/**
 * Parses raw drop-file bytes into a validated payload.
 *
 * Returns a result rather than throwing: every caller is a watcher loop where one bad file must
 * cost that file and nothing else, and the variants map to different behaviour — corruption is
 * unlinked, an unknown version is unlinked and logged.
 */
export function parseDropPayload(raw: string): DropParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: { kind: "json", message: String(error) } };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { ok: false, error: { kind: "json", message: "payload is not an object" } };
  }
  const raw_ = json as Record<string, unknown>;

  if (raw_["version"] !== PAYLOAD_VERSION) {
    return { ok: false, error: { kind: "unsupported-version", actual: raw_["version"] } };
  }
  for (const field of ["agentType", "event", "status"]) {
    const value = raw_[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      return { ok: false, error: { kind: "missing-field", field } };
    }
  }

  const body = clamp(str(raw_["body"]), BODY_MAX);
  return {
    ok: true,
    payload: {
      version: PAYLOAD_VERSION,
      sessionId: raw_["sessionId"] === null || raw_["sessionId"] === undefined
        ? null
        : clamp(str(raw_["sessionId"]), SESSION_ID_MAX).text,
      agentType: clamp(str(raw_["agentType"]), AGENT_TYPE_MAX).text,
      event: clamp(str(raw_["event"]), EVENT_MAX).text,
      status: clamp(str(raw_["status"]), STATUS_MAX).text,
      title: clamp(str(raw_["title"]), TITLE_MAX).text,
      body: body.text,
      userPrompt: clamp(str(raw_["userPrompt"]), USER_PROMPT_MAX).text,
      toolTarget: clamp(str(raw_["toolTarget"]), TOOL_TARGET_MAX).text,
      ...lines("linesAdded", raw_["linesAdded"]),
      ...lines("linesRemoved", raw_["linesRemoved"]),
      // OR, never assign: a producer that already clamped reports it, and this pass finding
      // nothing left to cut must not erase that.
      bodyTruncated: raw_["bodyTruncated"] === true || body.cut,
      transcriptPath: clamp(str(raw_["transcriptPath"]), TRANSCRIPT_PATH_MAX).text,
      cwd: clamp(str(raw_["cwd"]), CWD_MAX).text,
      pid: count(raw_["pid"]) ?? null,
      agentPid: count(raw_["agentPid"]) ?? null,
      paneId: typeof raw_["paneId"] === "string" && raw_["paneId"].length > 0 ? raw_["paneId"] : null,
      timestamp: count(raw_["timestamp"]) ?? 0,
    },
  };
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** Present only when the producer sent a number, so "no diff applies here" stays absent. */
function lines(field: string, value: unknown): Record<string, number> {
  const parsed = count(value);
  return parsed === undefined ? {} : { [field]: parsed };
}

/** A number the producer may have sent as anything. Negative and non-finite are not counts. */
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Clamps to `max` **UTF-16 code units**, never splitting a surrogate pair.
 *
 * The Rust side clamps bytes at a char boundary; the exact byte count differs but the property
 * that matters is the same one, and it is the only reason the second pass is safe: clamping an
 * already-clamped string is a no-op.
 */
function clamp(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let cut = max;
  // Never end on the high half of a surrogate pair — that is a lone code unit, not a character.
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return { text: text.slice(0, cut), cut: true };
}

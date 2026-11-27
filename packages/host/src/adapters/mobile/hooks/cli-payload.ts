/**
 * The CLI's **own** hook payload, read only for its transcript path (slice 3.1); kept apart from
 * `payload.ts` so a foreign format cannot edit our schema. **Fails soft** (`undefined`): a
 * `PreToolUse` hook exiting non-zero BLOCKS the tool, and the turn must still be recorded.
 */

/** Mirrors the schema's own cap; re-applied because this body never passed the producer. */
const TRANSCRIPT_PATH_MAX = 4096;
const SESSION_ID_MAX = 256;
const CWD_MAX = 4096;

/** What the CLI told us about where its history lives. */
export interface CliHookSource {
  transcriptPath: string;
  sessionId?: string;
  cwd?: string;
}

export function parseCliHookPayload(body: string): CliHookSource | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const payload = raw as Record<string, unknown>;

  const transcriptPath = str(payload["transcript_path"], TRANSCRIPT_PATH_MAX)
    ?? str(payload["transcriptPath"], TRANSCRIPT_PATH_MAX);
  // No path is not a fault: not every event carries one, and a caller that is not a CLI carries
  // none at all. There is simply nothing to record.
  if (transcriptPath === undefined) return undefined;

  const sessionId = str(payload["session_id"], SESSION_ID_MAX)
    ?? str(payload["sessionId"], SESSION_ID_MAX)
    ?? nestedSessionId(payload["session"]);
  const cwd = str(payload["cwd"], CWD_MAX);

  return {
    transcriptPath,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(cwd === undefined ? {} : { cwd }),
  };
}

/** Codex nests it: `session.id`. */
function nestedSessionId(session: unknown): string | undefined {
  if (session === null || typeof session !== "object" || Array.isArray(session)) return undefined;
  return str((session as Record<string, unknown>)["id"], SESSION_ID_MAX);
}

/**
 * A usable string, or nothing. Over-length is **refused rather than clamped**: a truncated
 * filesystem path is not a shorter path, it is a wrong one, and storing it would send the
 * transcript reader somewhere that does not exist.
 */
function str(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return undefined;
  return trimmed;
}

/**
 * Parses `codex exec --json` JSONL output. Codex emits one JSON object per line:
 * `thread.started` carries the `thread_id` (the resume handle / session id),
 * `item.completed` with `item.type === "agent_message"` carries reply text, and
 * an `error` event signals failure. Stray non-JSON lines are ignored.
 */
export interface CodexParsed {
  sessionId: string | null;
  text: string;
  isError: boolean;
}

interface CodexEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string };
  item?: { type?: string; text?: string };
}

/**
 * Pulls a human-readable message out of a codex `error` / `turn.failed` event.
 * codex nests its API errors as a JSON-encoded string inside `message`, so we
 * unwrap one level (`{error:{message}}`) when present, else use the raw string.
 */
function extractErrorMessage(event: CodexEvent): string | null {
  const raw = event.message ?? event.error?.message;
  if (typeof raw !== "string") return null;
  try {
    const nested = JSON.parse(raw) as { error?: { message?: string } };
    if (typeof nested.error?.message === "string") return nested.error.message;
  } catch {
    // raw was a plain string, not nested JSON — fall through.
  }
  return raw;
}

export function parseCodexJsonl(raw: string): CodexParsed {
  let sessionId: string | null = null;
  let isError = false;
  const parts: string[] = [];
  const errors: string[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: CodexEvent;
    try {
      event = JSON.parse(trimmed) as CodexEvent;
    } catch {
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      sessionId = event.thread_id;
    } else if (event.type === "error" || event.type === "turn.failed") {
      isError = true;
      const msg = extractErrorMessage(event);
      if (msg) errors.push(msg);
    } else if (
      event.type === "item.completed"
      && event.item?.type === "agent_message"
      && typeof event.item.text === "string"
    ) {
      parts.push(event.item.text);
    }
  }

  // When the turn failed with no assistant text, surface the error message so
  // callers never see a bare "(empty response)". Dedupe — codex usually emits
  // the same payload twice (error + turn.failed).
  let text = parts.join("\n");
  if (isError && !text && errors.length > 0) {
    text = [...new Set(errors)].join("\n");
  }

  return { sessionId, text, isError };
}

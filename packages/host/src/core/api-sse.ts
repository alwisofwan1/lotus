import type { NotificationEvent } from "../types/index.js";
import { ApiError } from "./api-error.js";

/**
 * Handle returned by `openSseStream()`. Provides a line-oriented async
 * iterable of SSE data payloads, and a `close()` to abort the stream.
 */
export interface SseStream {
  /** Async iterator that yields each SSE `data:` payload as a string. */
  lines(): AsyncIterable<string>;
  /** Abort the underlying fetch — safe to call multiple times. */
  close(): void;
}

/**
 * Handle returned by `openNotificationStream()`. Provides a typed async
 * iterable of parsed `NotificationEvent` objects, and a `close()` to abort.
 */
export interface NotificationStream {
  /** Async iterator that yields parsed `NotificationEvent` objects. */
  events(): AsyncIterable<NotificationEvent>;
  /** Abort the underlying fetch — safe to call multiple times. */
  close(): void;
}

/**
 * Decodes a single SSE line. The server JSON-encodes every payload (because
 * axum's `Event::data()` panics on raw `\r`/`\n`), so we `JSON.parse` to
 * recover the original string with newlines intact. Returns `null` for
 * non-data lines (`event:`, `id:`, comments, blank separators).
 */
export function decodeSseLine(line: string): string | null {
  if (!line.startsWith("data: ")) return null;
  const raw = line.slice(6);
  if (raw === "ping") return null; // keep-alive comment, ignore
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : String(parsed);
  } catch {
    // Defensive fallback: if a payload somehow isn't JSON, surface it
    // verbatim so the user sees something rather than nothing.
    return raw;
  }
}

/** Opens a fetch-based SSE stream yielding each `data:` payload as a string. */
export function openSseStream(url: string, headers: Record<string, string>): SseStream {
  const controller = new AbortController();

  const lines = async function* (): AsyncGenerator<string> {
    const resp = await fetch(url, { headers, signal: controller.signal });

    if (!resp.ok) {
      throw new ApiError(resp.status, resp.statusText);
    }
    if (!resp.body) {
      throw new Error("SSE response has no body");
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let leftover = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        leftover += decoder.decode(value, { stream: true });
        const boundary = leftover.lastIndexOf("\n");
        if (boundary === -1) continue;

        const complete = leftover.slice(0, boundary + 1);
        leftover = leftover.slice(boundary + 1);

        for (const line of complete.split("\n")) {
          const decoded = decodeSseLine(line);
          if (decoded !== null) yield decoded;
        }
      }

      // Flush any remaining partial line
      const trailing = decodeSseLine(leftover);
      if (trailing !== null) yield trailing;
    } finally {
      reader.releaseLock();
    }
  };

  return {
    lines,
    close() {
      controller.abort();
    },
  };
}

/**
 * Opens a fetch-based SSE stream for the notification channel. Each data
 * payload is a JSON-encoded `NotificationEvent` (not double-encoded), so the
 * stream yields parsed objects directly. Reconnection is the caller's job.
 */
export function openNotificationStream(url: string, headers: Record<string, string>): NotificationStream {
  const controller = new AbortController();

  const events = async function* (): AsyncGenerator<NotificationEvent> {
    const resp = await fetch(url, { headers, signal: controller.signal });

    if (!resp.ok) {
      throw new ApiError(resp.status, resp.statusText);
    }
    if (!resp.body) {
      throw new Error("SSE response has no body");
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let leftover = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        leftover += decoder.decode(value, { stream: true });
        const boundary = leftover.lastIndexOf("\n");
        if (boundary === -1) continue;

        const complete = leftover.slice(0, boundary + 1);
        leftover = leftover.slice(boundary + 1);

        for (const line of complete.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === "ping") continue;
          try {
            yield JSON.parse(raw) as NotificationEvent;
          } catch {
            // skip malformed frames
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  };

  return {
    events,
    close() {
      controller.abort();
    },
  };
}

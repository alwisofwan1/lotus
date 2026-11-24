import { ApiError } from "./api-client.js";
import type { FocusInfo, SessionStore } from "./session-store.js";

export type WithFocusResult<T> =
  | { kind: "ok"; result: T }
  | { kind: "no_focus" }
  | { kind: "stale"; what: "workspace" | "pane" }
  | { kind: "offline"; reason: string };

export type FocusRequirement = "workspace" | "pane";

const STALE_HTTP_STATUSES = new Set([404, 410]);
const OFFLINE_CAUSE_CODES = new Set(["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND"]);

/**
 * Wraps a focus-bound operation with three protections:
 *
 * 1. **Pre-check** — returns `no_focus` immediately if the operator has not
 *    `/focus`-ed yet, or has only set a workspace when `require="pane"`.
 * 2. **Stale recovery** — on HTTP 404/410 from `fn`, clears the persisted
 *    focus so the next command starts fresh, and returns a `stale` result
 *    the caller can render as a friendly "workspace/cell is gone" message.
 * 3. **Offline pass-through** — on a TCP connection failure (Lotus desktop
 *    closed or unreachable), preserves focus and returns `offline` so the
 *    operator just reopens Lotus and retries without re-typing `/focus`.
 *
 * Anything else is rethrown so callers can fall through to their own error
 * handling without losing the original stack.
 */
export async function withFocus<T>(
  deviceId: string,
  store: SessionStore,
  require: FocusRequirement,
  fn: (focus: FocusInfo) => Promise<T>,
): Promise<WithFocusResult<T>> {
  const focus = store.getFocus(deviceId);
  if (!focus) return { kind: "no_focus" };
  if (require === "pane" && focus.paneId === undefined) return { kind: "no_focus" };

  try {
    const result = await fn(focus);
    return { kind: "ok", result };
  } catch (err) {
    if (err instanceof ApiError && STALE_HTTP_STATUSES.has(err.status)) {
      const what: "workspace" | "pane" =
        require === "pane" ? "pane" : "workspace";
      store.clearFocus(deviceId);
      return { kind: "stale", what };
    }
    const offline = detectOffline(err);
    if (offline) return { kind: "offline", reason: offline };
    throw err;
  }
}

function detectOffline(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: string }).code;
    if (code !== undefined && OFFLINE_CAUSE_CODES.has(code)) return code;
  }
  // Bun in some scenarios surfaces the code on the error itself.
  const directCode = (err as Error & { code?: string }).code;
  if (directCode !== undefined && OFFLINE_CAUSE_CODES.has(directCode)) return directCode;
  return null;
}

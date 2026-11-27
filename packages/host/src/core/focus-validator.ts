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

/** Clear stale focus, but preserve it when the host is temporarily offline. */
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

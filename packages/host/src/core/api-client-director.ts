import type { ClientRequest } from "./api-client-util.js";

/**
 * Submits a goal to the Headless Director (ADR-0019). Resolves once the host has accepted it
 * (202); the reply arrives asynchronously as a `director_reply` notification. Rejects with
 * `ApiError` 503 when no Director is enabled on the host.
 */
export function submitDirectorGoal(
  request: ClientRequest,
  text: string,
): Promise<{ ok: boolean; accepted: boolean }> {
  return request<{ ok: boolean; accepted: boolean }>("POST", "/api/director/goal", { text });
}

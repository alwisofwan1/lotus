/** `ApiClient.request`, handed to the split-out surfaces so each stays functions rather
 *  than a second client. */
export type ClientRequest = <T>(method: string, path: string, body?: unknown) => Promise<T>;

// Pure request/response helpers for `ApiClient`. Extracted when the client hit the
// 300-line limit: these are the natural collaborator, being the only part of the
// file that does not touch HTTP or client state.

/** Pulls `{ error }` out of a JSON error body, or undefined if absent/unparseable. */
export function parseErrorMessage(raw: string): string | undefined {
  try {
    const body = JSON.parse(raw) as { error?: unknown };
    return typeof body.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds a `?k=v&k=v` query string, omitting `undefined` values entirely so
 * the server sees the same shape as if the key was never provided. Encodes
 * with encodeURIComponent — caller is not expected to pre-encode.
 */
export function buildQueryString(params: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

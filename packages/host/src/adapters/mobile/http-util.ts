import type { Device } from "./device-store.js";

/**
 * The bearer check every `/m/*` route but `/m/pair` shares, supplied by the main router.
 * Declared once here because two route files take it and a second copy would drift.
 */
export type GuardedRoute = (
  handler: (ctx: {
    req: IncomingMessage;
    res: ServerResponse;
    params: Record<string, string>;
    device: Device;
  }) => Promise<void>,
) => (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;

import type { IncomingMessage, ServerResponse } from "node:http";

import { ApiError } from "../../core/api-error.js";

import { readJson } from "../../server/routes/utils.js";

/**
 * The request/response plumbing every `/m/*` route shares, split from `http-routes.ts`
 * (300-line limit); `device-routes.ts` needs it without the route table.
 */

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function bearerOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") === true ? header.slice(7) : undefined;
}

/** Reads a JSON object body, answering 400 itself when the body is unusable. */
export async function body_(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes?: number,
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = await readJson<unknown>(req, maxBytes);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      send(res, 400, { error: "Body must be a JSON object" });
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    send(res, 400, { error: "Invalid JSON body" });
    return undefined;
  }
}

export function query(req: IncomingMessage, key: string): string | undefined {
  const raw = new URL(req.url ?? "/", "http://localhost").searchParams.get(key);
  return raw === null || raw.length === 0 ? undefined : raw;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** `before`/`limit` off the query string, ignoring anything that is not a number. */
export function pageQuery(req: IncomingMessage): { before?: number; limit?: number } {
  const url = new URL(req.url ?? "/", "http://localhost");
  const num = (key: string): number | undefined => {
    const raw = url.searchParams.get(key);
    if (raw === null) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
  };
  const before = num("before");
  const limit = num("limit");
  // exactOptionalPropertyTypes: an explicit undefined is not the same as an absent key.
  return { ...(before === undefined ? {} : { before }), ...(limit === undefined ? {} : { limit }) };
}

/**
 * Answers a phone with what the **desktop** said, when the desktop refused; returns whether
 * it answered. A 4xx (and 503, "open the window") is about the request, so the caller reads
 * it; a 5xx is the machine's own trouble and is not forwarded.
 */
export function sendUpstream(res: ServerResponse, err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  if (err.status >= 500 && err.status !== 503) return false;
  send(res, err.status, { error: err.message });
  return true;
}

import type { IncomingMessage } from "node:http";

/**
 * Default body cap. Every request but dictation is a small JSON object, and the
 * mobile façade listens on a tailnet address — so the ceiling stays low by default
 * and is raised explicitly by the one route that needs room.
 */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/** Reads and JSON-parses the request body. Rejects on invalid JSON or an oversized body. */
export function readJson<T>(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<T> {
  return readBody(req, maxBytes).then((raw) => {
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error("Invalid JSON body");
    }
  });
}

/**
 * The body as text, unparsed. For a caller that must look at the same bytes twice — the hook
 * endpoint reads Lotus's own fields and the CLI's own payload out of one request (slice 3.1).
 */
export function readBody(
  req: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer | string) => {
      if (aborted) return;
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      size += buffer.length;
      if (size > maxBytes) {
        // Drop what was buffered rather than hold it until `end`: the point is to
        // bound memory, so keeping the prefix around would defeat the cap.
        aborted = true;
        chunks.length = 0;
        reject(new Error(`Body too large (over ${maxBytes} bytes)`));
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks, size).toString("utf8"));
    });
    req.on("error", reject);
  });
}

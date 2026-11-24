import type { IncomingMessage, ServerResponse } from "node:http";

export interface StreamReplyOptions {
  /** Whitespace heartbeat interval — must stay well under the client body timeout. */
  heartbeatMs: number;
  /** Abort the work (and kill its child) after this long. */
  timeoutMs: number;
}

/** Final frame the client distinguishes from a success payload by `error`. */
export interface ErrorFrame {
  error: string;
  errorStatus?: number;
}

function canWrite(res: ServerResponse): boolean {
  return !res.writableEnded && !res.destroyed;
}

/**
 * Streams a long-running JSON reply without tripping HTTP/undici header & body
 * timeouts: sends `200` + headers immediately, emits whitespace heartbeats while
 * `work` runs (each resets the client's body timeout), then writes the single
 * final JSON value. Heartbeats are JSON whitespace, so the client parses the
 * whole body with a plain `JSON.parse`. A turn exceeding `timeoutMs` — or a
 * client that disconnects — aborts the signal so `work` can kill its child.
 */
export async function streamJsonReply(
  req: IncomingMessage,
  res: ServerResponse,
  work: (signal: AbortSignal) => Promise<unknown>,
  toErrorFrame: (err: unknown) => ErrorFrame,
  opts: StreamReplyOptions,
): Promise<void> {
  const controller = new AbortController();
  const onClose = (): void => controller.abort("client disconnected");
  req.on("close", onClose);
  const timeout = setTimeout(
    () => controller.abort(`bridge turn exceeded ${opts.timeoutMs}ms`),
    opts.timeoutMs,
  );

  res.writeHead(200, { "Content-Type": "application/json" });
  const heartbeat = setInterval(() => {
    if (canWrite(res)) res.write("\n");
  }, opts.heartbeatMs);

  let frame: unknown;
  try {
    frame = await work(controller.signal);
  } catch (err) {
    frame = toErrorFrame(err);
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    req.off("close", onClose);
  }

  if (canWrite(res)) res.end(JSON.stringify(frame));
}

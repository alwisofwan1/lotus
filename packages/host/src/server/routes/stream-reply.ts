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

/** Send JSON whitespace heartbeats to prevent idle timeouts and abort work on disconnect or deadline. */
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

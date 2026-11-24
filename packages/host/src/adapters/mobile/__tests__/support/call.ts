import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { Router } from "../../../../server/router.js";

export interface CallResult {
  status: number;
  json: unknown;
}

/**
 * Drives a `Router` without binding a port — the routes are the unit under test,
 * not node's HTTP parser.
 */
export interface CallSource {
  /** Extra request headers — `cf-connecting-ip` and friends for throttling tests. */
  headers?: Record<string, string>;
  /** What `req.socket.remoteAddress` reports. */
  remoteAddress?: string;
}

export function call(
  router: Router,
  method: string,
  url: string,
  body: unknown = undefined,
  bearer?: string,
  source: CallSource = {},
): Promise<CallResult> {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    ...(source.headers ?? {}),
  };
  // Routes that throttle read the socket as their last resort; without one they would
  // throw rather than fall back, and the test would be about the helper.
  (req as { socket?: unknown }).socket = { remoteAddress: source.remoteAddress ?? "127.0.0.1" };

  return new Promise<CallResult>((resolve, reject) => {
    let status = 0;
    let ended = false;
    const chunks: string[] = [];
    const res = {
      get writableEnded() {
        return ended;
      },
      writeHead(code: number) {
        status = code;
        return res;
      },
      end(chunk?: string) {
        if (chunk !== undefined) chunks.push(chunk);
        ended = true;
        const raw = chunks.join("");
        resolve({ status, json: raw.length > 0 ? JSON.parse(raw) : null });
      },
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    } as unknown as ServerResponse;

    if (!router.dispatch(req, res)) {
      reject(new Error(`no route matched ${method} ${url}`));
      return;
    }

    // The handler reads the body from the request stream; feed it after dispatch
    // so listeners are attached first.
    setImmediate(() => {
      if (body !== undefined) req.emit("data", JSON.stringify(body));
      req.emit("end");
    });
  });
}

import type { ServerResponse } from "node:http";
import type { PtyManager } from "../pty/manager.js";
import type { RouteHandler } from "../router.js";
import { SessionNotFoundError } from "../pty/errors.js";
import { readJson } from "./utils.js";
import type { CreateSessionRequest, SessionInfo } from "../../types/index.js";

function send404(res: ServerResponse, id: string): void {
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: `Session not found: ${id}` }));
}

export function listSessionsHandler(ptyManager: PtyManager): RouteHandler {
  return (_req, res) => {
    const body: SessionInfo[] = ptyManager.list().map((s) => ({ id: s.id, cwd: s.cwd }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
}

export function createSessionHandler(ptyManager: PtyManager): RouteHandler {
  return async (req, res) => {
    let body: CreateSessionRequest = {};
    try {
      body = await readJson<CreateSessionRequest>(req);
    } catch {
      // empty or missing body is valid for createSession
    }
    const state = ptyManager.create(body);
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessionId: state.id }));
  };
}

export function writeSessionHandler(ptyManager: PtyManager): RouteHandler {
  return async (req, res, params) => {
    const id = params["id"] ?? "";
    try {
      const body = await readJson<{ data: string }>(req);
      ptyManager.write(id, body.data);
      res.writeHead(204);
      res.end();
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        send404(res, id);
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad request" }));
      }
    }
  };
}

export function resizeSessionHandler(ptyManager: PtyManager): RouteHandler {
  return async (req, res, params) => {
    const id = params["id"] ?? "";
    try {
      const body = await readJson<{ cols: number; rows: number }>(req);
      ptyManager.resize(id, body.cols, body.rows);
      res.writeHead(204);
      res.end();
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        send404(res, id);
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad request" }));
      }
    }
  };
}

export function killSessionHandler(ptyManager: PtyManager): RouteHandler {
  return (_req, res, params) => {
    const id = params["id"] ?? "";
    try {
      ptyManager.kill(id);
      res.writeHead(204);
      res.end();
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        send404(res, id);
      } else throw err;
    }
  };
}

export function streamSessionHandler(ptyManager: PtyManager): RouteHandler {
  return (req, res, params) => {
    const id = params["id"] ?? "";
    let session;
    try {
      session = ptyManager.getSession(id);
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        send404(res, id);
        return;
      }
      throw err;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    let closed = false;
    const unsubscribe = session.subscribeData((chunk) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      else cleanup();
    });

    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(pingInterval);
      if (!res.writableEnded) res.end();
    };

    // Send buffered tail after subscribing so no chunk can be missed in between.
    const tail = session.getBufferTail();
    if (tail) res.write(`data: ${JSON.stringify(tail)}\n\n`);

    const pingInterval = setInterval(() => {
      if (!res.writableEnded) res.write("data: ping\n\n");
      else cleanup();
    }, 30_000);

    session.onExit(cleanup);
    req.on("close", cleanup);
    res.on("error", cleanup);
  };
}

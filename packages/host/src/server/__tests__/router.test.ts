import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Router } from "../router.js";

function makeReq(method: string, url: string): IncomingMessage {
  return { method, url } as unknown as IncomingMessage;
}

function makeRes() {
  const state = { statusCode: 200, body: "", ended: false };
  const res = {
    writeHead(code: number) {
      state.statusCode = code;
    },
    end(chunk?: string) {
      state.ended = true;
      if (chunk) state.body += chunk;
    },
    get writableEnded() {
      return state.ended;
    },
  } as unknown as ServerResponse;
  return { res, state };
}

describe("Router", () => {
  it("calls handler for exact path match", async () => {
    const router = new Router();
    const handler = vi.fn();
    router.add("GET", "/health", handler);
    const { res } = makeRes();
    const matched = router.dispatch(makeReq("GET", "/health"), res);
    expect(matched).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("returns false for unregistered path", () => {
    const router = new Router();
    router.add("GET", "/health", vi.fn());
    const { res } = makeRes();
    expect(router.dispatch(makeReq("GET", "/unknown"), res)).toBe(false);
  });

  it("returns false for wrong method", () => {
    const router = new Router();
    router.add("GET", "/health", vi.fn());
    const { res } = makeRes();
    expect(router.dispatch(makeReq("POST", "/health"), res)).toBe(false);
  });

  it("extracts single path param", async () => {
    const router = new Router();
    let captured: Record<string, string> = {};
    router.add("GET", "/api/sessions/:id/stream", (_req, _res, params) => {
      captured = params;
    });
    const { res } = makeRes();
    router.dispatch(makeReq("GET", "/api/sessions/abc-123/stream"), res);
    await new Promise((r) => setTimeout(r, 0));
    expect(captured).toEqual({ id: "abc-123" });
  });

  it.each(["%E0", "%", "%GG"])("returns 400 for malformed parameter %s without calling the handler", (encoded) => {
    const router = new Router();
    const handler = vi.fn();
    router.add("GET", "/api/sessions/:id/stream", handler);
    const { res, state } = makeRes();

    expect(router.dispatch(makeReq("GET", `/api/sessions/${encoded}/stream`), res)).toBe(true);
    expect(state.statusCode).toBe(400);
    expect(state.ended).toBe(true);
    expect(JSON.parse(state.body)).toEqual({ error: "Invalid URL parameter" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("decodes valid UTF-8 parameters", () => {
    const router = new Router();
    const handler = vi.fn();
    router.add("GET", "/api/sessions/:id/stream", handler);
    const req = makeReq("GET", "/api/sessions/caf%C3%A9/stream");
    const { res } = makeRes();

    expect(router.dispatch(req, res)).toBe(true);
    expect(handler).toHaveBeenCalledWith(req, res, { id: "café" });
  });

  it("extracts multiple path params", async () => {
    const router = new Router();
    let captured: Record<string, string> = {};
    router.add("GET", "/api/:resource/:id", (_req, _res, params) => {
      captured = params;
    });
    const { res } = makeRes();
    router.dispatch(makeReq("GET", "/api/sessions/xyz"), res);
    await new Promise((r) => setTimeout(r, 0));
    expect(captured).toEqual({ resource: "sessions", id: "xyz" });
  });

  it("strips query string before matching", async () => {
    const router = new Router();
    const handler = vi.fn();
    router.add("GET", "/health", handler);
    const { res } = makeRes();
    const matched = router.dispatch(makeReq("GET", "/health?foo=bar"), res);
    expect(matched).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("passes req and res to handler", async () => {
    const router = new Router();
    let capturedReq: IncomingMessage | undefined;
    let capturedRes: ServerResponse | undefined;
    router.add("GET", "/health", (req, res) => {
      capturedReq = req;
      capturedRes = res;
    });
    const req = makeReq("GET", "/health");
    const { res } = makeRes();
    router.dispatch(req, res);
    await new Promise((r) => setTimeout(r, 0));
    expect(capturedReq).toBe(req);
    expect(capturedRes).toBe(res);
  });

  // The contract guard enumerates the mobile surface from the router itself. A
  // hand-written second list is exactly what let three routes ship without a
  // fixture: both copies passed their own tests while disagreeing.
  it("lists the routes it was given, in registration order", () => {
    const router = new Router();
    router.add("get", "/m/bootstrap", vi.fn());
    router.add("GET", "/m/cell/:paneId/transcript", vi.fn());

    expect(router.list()).toEqual([
      { method: "GET", path: "/m/bootstrap" },
      { method: "GET", path: "/m/cell/:paneId/transcript" },
    ]);
  });

  it("returns 500 when async handler throws", async () => {
    const router = new Router();
    router.add("GET", "/boom", async () => {
      throw new Error("test error");
    });
    const { res, state } = makeRes();
    router.dispatch(makeReq("GET", "/boom"), res);
    await new Promise((r) => setTimeout(r, 10));
    expect(state.statusCode).toBe(500);
  });
});

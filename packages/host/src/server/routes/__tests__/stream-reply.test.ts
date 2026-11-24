import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { streamJsonReply } from "../stream-reply.js";

function makeReq(): IncomingMessage {
  return new EventEmitter() as unknown as IncomingMessage;
}

interface MockRes extends ServerResponse {
  chunks: string[];
  body: string;
}

function makeRes(): MockRes {
  const chunks: string[] = [];
  let ended = false;
  const res = {
    destroyed: false,
    writeHead: vi.fn(),
    write: vi.fn((s: string) => { chunks.push(s); return true; }),
    end: vi.fn((s?: string) => { if (s) chunks.push(s); ended = true; }),
    get writableEnded() { return ended; },
    chunks,
    get body() { return chunks.join(""); },
  };
  return res as unknown as MockRes;
}

const FAST_OPTS = { heartbeatMs: 10_000, timeoutMs: 10_000 };

describe("streamJsonReply", () => {
  it("writes 200 + the final JSON value, no heartbeat, on fast work", async () => {
    const res = makeRes();
    await streamJsonReply(makeReq(), res, async () => ({ ok: true, n: 1 }), () => ({ error: "x" }), FAST_OPTS);
    expect(res.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json" });
    expect(res.body).toBe(JSON.stringify({ ok: true, n: 1 }));
    expect(JSON.parse(res.body)).toEqual({ ok: true, n: 1 });
  });

  it("emits whitespace heartbeats during slow work; body still parses as JSON", async () => {
    const res = makeRes();
    const work = (): Promise<unknown> => new Promise((r) => setTimeout(() => r({ done: true }), 60));
    await streamJsonReply(makeReq(), res, work, () => ({ error: "x" }), { heartbeatMs: 10, timeoutMs: 10_000 });
    // Heartbeats are bare newlines (JSON whitespace) so the assembled body parses cleanly.
    expect(res.chunks.filter((c) => c === "\n").length).toBeGreaterThan(0);
    expect(JSON.parse(res.body)).toEqual({ done: true });
  });

  it("aborts the work signal and returns an error frame on timeout", async () => {
    const res = makeRes();
    const work = (signal: AbortSignal): Promise<unknown> =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error(String(signal.reason))), { once: true });
      });
    await streamJsonReply(makeReq(), res, work, (err) => ({ error: (err as Error).message, errorStatus: 504 }), { heartbeatMs: 1_000, timeoutMs: 20 });
    const frame = JSON.parse(res.body) as { error: string; errorStatus: number };
    expect(frame.errorStatus).toBe(504);
    expect(frame.error).toContain("exceeded");
  });

  it("aborts the work signal when the client disconnects", async () => {
    const req = makeReq();
    const res = makeRes();
    let aborted = false;
    const work = (signal: AbortSignal): Promise<unknown> =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
      });
    const p = streamJsonReply(req, res, work, () => ({ error: "disconnected" }), { heartbeatMs: 1_000, timeoutMs: 10_000 });
    (req as unknown as EventEmitter).emit("close");
    await p;
    expect(aborted).toBe(true);
  });
});

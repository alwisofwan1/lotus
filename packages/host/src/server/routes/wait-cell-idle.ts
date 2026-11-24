import type { ServerResponse } from "node:http";
import type { RouteHandler } from "../router.js";
import type { PtyManager } from "../pty/manager.js";
import { SessionNotFoundError } from "../pty/errors.js";
import {
  classifyCellState,
  defaultWaitTimeoutMs,
  isIdle,
  isSettled,
  legacyState,
  stripAnsi,
  type CellReadiness,
} from "../fleet/cell-readiness.js";
import { readJson } from "./utils.js";

/**
 * `/v1/wait-cell-idle` — polls a cell's output until it settles at a prompt /
 * dialog or the deadline expires, mirroring the desktop `mcp_ipc.rs` response
 * (`{ ok, idle, state, readiness, matched, suggestedInput, tail, waitedMs }`).
 * This is how the Headless Director knows a worker turn has finished.
 */

const TAIL_BYTES = 8192;
const EXCERPT_CHARS = 512;
const POLL_INTERVAL_MS = 180;
const CEILING_MS = 60_000;

interface WaitBody { pane_id?: string; timeout_ms?: number; signatures?: string[] }

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Outcome { readiness: CellReadiness; matched: string | null; suggestedInput: string | null; tail: string; waitedMs: number }

async function pollUntilSettled(
  read: () => string,
  timeoutMs: number,
  customSignatures: string[] | undefined,
): Promise<Outcome> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  for (;;) {
    const tail = read();
    const c = classifyCellState(tail, customSignatures);
    const settled = isSettled(c.readiness);
    if (settled || Date.now() >= deadline) {
      return {
        readiness: settled ? c.readiness : "busy",
        matched: settled ? c.matched : null,
        suggestedInput: settled ? c.suggestedInput : null,
        tail: stripAnsi(tail).slice(-EXCERPT_CHARS),
        waitedMs: Date.now() - started,
      };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export function waitCellIdleHandler(ptyManager: PtyManager): RouteHandler {
  return async (req, res) => {
    const body = await readJson<WaitBody>(req).catch(() => null);
    if (!body) return send(res, 400, { error: "Invalid JSON body" });
    if (!body.pane_id) return send(res, 400, { error: "pane_id is required" });

    let session;
    try {
      session = ptyManager.getSession(body.pane_id);
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        return send(res, 404, { error: `no live session for paneId=${body.pane_id}` });
      }
      throw err;
    }

    const provider = session.state.provider;
    const timeoutMs = Math.min(body.timeout_ms ?? defaultWaitTimeoutMs(provider), CEILING_MS);
    const customSignatures = body.signatures && body.signatures.length > 0
      ? body.signatures.map((s) => s.toLowerCase())
      : undefined;

    const outcome = await pollUntilSettled(() => session.getBufferTail(TAIL_BYTES), timeoutMs, customSignatures);
    send(res, 200, {
      ok: true,
      idle: isIdle(outcome.readiness),
      state: legacyState(outcome.readiness),
      readiness: outcome.readiness,
      matched: outcome.matched,
      suggestedInput: outcome.suggestedInput,
      tail: outcome.tail,
      waitedMs: outcome.waitedMs,
    });
  };
}

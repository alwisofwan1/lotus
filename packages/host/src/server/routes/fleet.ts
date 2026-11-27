import { basename } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PtyManager } from "../pty/manager.js";
import { SessionNotFoundError } from "../pty/errors.js";
import type { RouteHandler } from "../router.js";
import { readJson } from "./utils.js";
import type {
  DispatchRequest,
  FleetMember,
  ListFleetResponse,
  ReadCellRequest,
  ReadCellResponse,
  ScrollbackRequest,
  ScrollbackResponse,
} from "../../types/index.js";
import type { PtySessionState } from "../pty/types.js";
import { gatingFor } from "../agent/gating.js";
import { dispatchWritePlan, type DispatchWritePlan } from "../fleet/dispatch-plan.js";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;
const MAX_TAIL_BYTES = 64 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Inject cached headlines so fleet polling does not reread runner transcripts. */
export type HeadlineOf = (paneId: string) => string | undefined;

/** Use recorded hooks so fleet state reflects the agent's last reported turn. */
export type TurnOf = (paneId: string) => { status: string; at: number } | undefined;

export function listFleetHandler(
  ptyManager: PtyManager,
  headlineOf?: HeadlineOf,
  turnOf?: TurnOf,
): RouteHandler {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const workspaceId = url.searchParams.get("workspaceId") ?? undefined;
    const page = parsePositiveInt(url.searchParams.get("page"), DEFAULT_PAGE);
    const pageSize = Math.min(
      parsePositiveInt(url.searchParams.get("pageSize"), DEFAULT_PAGE_SIZE),
      MAX_PAGE_SIZE,
    );

    const all = ptyManager
      .list()
      .map((state) => toFleetMember(state, headlineOf?.(state.id), turnOf?.(state.id)))
      .filter((member) => workspaceId === undefined || member.workspaceId === workspaceId);
    const offset = (page - 1) * pageSize;
    const body: ListFleetResponse = {
      items: all.slice(offset, offset + pageSize),
      total: all.length,
      page,
      pageSize,
    };
    sendJson(res, 200, body);
  };
}

/** Return absolute offsets so reconnecting clients can resume (issues/05). */
export function readScrollbackHandler(ptyManager: PtyManager): RouteHandler {
  return async (req, res): Promise<void> => {
    let body: ScrollbackRequest;
    try {
      body = await readJson<ScrollbackRequest>(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    if (!body.paneId) {
      sendJson(res, 400, { error: "paneId is required" });
      return;
    }

    try {
      const session = ptyManager.getSession(body.paneId);
      const { text, offset } = session.readScrollback(
        Math.max(0, body.fromByte ?? 0),
        clampTailBytes(body.maxBytes),
      );
      const response: ScrollbackResponse = {
        paneId: body.paneId,
        text,
        offset,
        totalBytes: session.bytesSeen,
      };
      sendJson(res, 200, response);
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        sendJson(res, 404, { error: `Cell not found: ${body.paneId}` });
        return;
      }
      throw err;
    }
  };
}

export function readCellHandler(ptyManager: PtyManager): RouteHandler {
  return async (req, res): Promise<void> => {
    let body: ReadCellRequest;
    try {
      body = await readJson<ReadCellRequest>(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    if (!body.paneId) {
      sendJson(res, 400, { error: "paneId is required" });
      return;
    }

    try {
      const tailBytes = clampTailBytes(body.tailBytes);
      const tail = ptyManager.getSession(body.paneId).getBufferTail(tailBytes);
      const response: ReadCellResponse = {
        paneId: body.paneId,
        tail,
        bytes: Buffer.byteLength(tail, "utf8"),
      };
      sendJson(res, 200, response);
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        sendJson(res, 404, { error: `Cell not found: ${body.paneId}` });
        return;
      }
      throw err;
    }
  };
}

export function dispatchCellHandler(ptyManager: PtyManager): RouteHandler {
  return async (req, res): Promise<void> => {
    let body: DispatchRequest;
    try {
      body = await readJson<DispatchRequest>(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    if (!body.paneId || !body.command) {
      sendJson(res, 400, { error: "paneId and command are required" });
      return;
    }

    try {
      const session = ptyManager.getSession(body.paneId);
      // Two writes, a beat apart — see `dispatchWritePlan`. Writing `${command}\n` in one
      // call put a phone's sentence in Codex's composer and left it there (2026-09-05).
      const plan = dispatchWritePlan(body.command, body.appendNewline !== false);
      await writePlan(session, plan);
      sendJson(res, 200, {
        paneId: body.paneId,
        bytesWritten: plan.bytes,
        tailPreview: session.getBufferTail(1024),
      });
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        sendJson(res, 404, { error: `Cell not found: ${body.paneId}` });
        return;
      }
      throw err;
    }
  };
}

function toFleetMember(
  state: PtySessionState,
  headline?: string,
  turn?: { status: string; at: number },
): FleetMember {
  const workspaceId = state.workspaceId ?? state.cwd;
  const gating = gatingFor(state.provider ?? "claude", state.permissionMode);
  return {
    paneId: state.id,
    workspaceId,
    agentType: state.provider ?? "claude",
    // What the operator recognises, when it is not simply the family: the account behind a
    // `ccs` runner. Absent for a native one, where the family already is the name.
    ...(state.runnerLabel === undefined ? {} : { runnerLabel: state.runnerLabel }),
    title: state.title ?? (basename(state.cwd) || state.cwd),
    status: state.status,
    isAlive: state.status === "running",
    // Pane and session are the same object here, unlike on the desktop where a
    // pane wraps one. Remote clients address output and interrupts by session, so
    // omitting this made every `stop` from a phone 404 against a VPS.
    sessionId: state.id,
    // Derive reported posture from the flags used at launch (issue 25).
    ...(gating === undefined ? {} : { gating }),
    // The line the operator reads under the cell's name. A terminal cell had none until
    // 2026-09-08 — beside a Codex cell that did — while the title it wanted sat in the
    // runner's own transcript (`transcript/claude-transcript.ts`).
    ...(headline === undefined ? {} : { headline }),
    // Absent stays absent: *no hook has spoken for this pane* and *the pane is idle* are
    // different claims, and the phone draws them differently (`unknown` vs a state).
    ...(turn === undefined ? {} : { turn: turn.status, turnAgeMs: Math.max(0, Date.now() - turn.at) }),
  };
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampTailBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 4096;
  return Math.min(Math.floor(value), MAX_TAIL_BYTES);
}

/** Performs a {@link DispatchWritePlan}, pausing before the submit key. */
async function writePlan(
  session: { write(data: string): void },
  plan: DispatchWritePlan,
): Promise<void> {
  const [body, submit] = plan.writes;
  session.write(body ?? "");
  if (submit === undefined) return;
  await new Promise((resolve) => setTimeout(resolve, plan.delayBeforeSubmitMs));
  session.write(submit);
}

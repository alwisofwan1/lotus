import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConversationUpdate } from "../../types/conversation.js";
import type { RouteHandler } from "../router.js";
import type { StructuredFleetRef } from "../structured-fleet-ref.js";

/** Bumped when a frame's shape changes in a way an older desktop cannot read. */
export const CONVERSATION_STREAM_PROTOCOL = 1;

/** Per process: the delta cursor restarts with the host, so a cursor is only valid with its boot id. */
const PROCESS_BOOT_ID = randomUUID();

export interface ConversationStreamOptions {
  bootId?: string;
  heartbeatMs?: number;
  /** Unsent bytes allowed before a slow client is cut; it reconnects and replays from its cursor. */
  maxBufferedBytes?: number;
}

interface Delta {
  cursor: number;
  agentType: string;
  update: ConversationUpdate;
}

/** `Last-Event-ID: <boot>:<cursor>` wins over `?boot=&after=` (a first connect has only the query). */
function resumePoint(req: IncomingMessage, query: URLSearchParams): { boot: string | null; cursor: number } {
  const header = req.headers["last-event-id"];
  const raw = typeof header === "string" && header.includes(":")
    ? header
    : `${query.get("boot") ?? ""}:${query.get("after") ?? "0"}`;
  const at = raw.lastIndexOf(":");
  const cursor = Number.parseInt(raw.slice(at + 1), 10);
  return { boot: raw.slice(0, at) || null, cursor: Number.isFinite(cursor) && cursor > 0 ? cursor : 0 };
}

function json(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * `GET /v1/cell-conversation/stream?pane_id=` — a headless cell's deltas as SSE, for the desktop Chat.
 *
 * Same log and cursor as the phone's `/m/stream` lane, so both clients see one conversation.
 */
export function structuredConversationStreamHandler(
  structured: StructuredFleetRef | undefined,
  opts: ConversationStreamOptions = {},
): RouteHandler {
  const bootId = opts.bootId ?? PROCESS_BOOT_ID;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const maxBuffered = opts.maxBufferedBytes ?? 1024 * 1024;

  return (req, res) => {
    const query = new URL(req.url ?? "/", "http://host").searchParams;
    const paneId = (query.get("pane_id") ?? "").trim();
    if (paneId === "") return json(res, 400, { ok: false, error: "pane_id is required" });
    if (structured !== undefined && !structured.ready()) {
      return json(res, 503, { ok: false, error: "this host is starting or stopping; retry", paneId });
    }
    if (structured?.page(paneId) === undefined) {
      return json(res, 404, { ok: false, error: "no headless cell with that paneId on this host", paneId });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let offClose = (): void => {};
    const write = (frame: string): void => {
      if (closed) return;
      if (!res.write(frame) && res.writableLength > maxBuffered) cleanup();
    };
    const send = (d: Delta): void =>
      write(`id: ${bootId}:${d.cursor}\nevent: conversation\ndata: ${JSON.stringify({ paneId, ...d })}\n\n`);

    write(`event: hello\ndata: ${JSON.stringify({ protocol: CONVERSATION_STREAM_PROTOCOL, bootId, paneId })}\n\n`);

    // Subscribe before replaying, and hold live deltas until the replay is out, so none falls between.
    let pending: Delta[] | null = [];
    let lastSent = 0;
    const unsubscribe = structured.subscribe((p, agentType, update, cursor) => {
      if (p !== paneId) return;
      if (pending !== null) pending.push({ cursor, agentType, update });
      else send({ cursor, agentType, update });
    });

    const { boot, cursor } = resumePoint(req, query);
    const restarted = cursor > 0 && boot !== bootId;
    const answer = structured.since(paneId, restarted ? 0 : cursor);
    if (restarted || answer.truncated) {
      write(`event: truncated\ndata: ${JSON.stringify({
        reason: restarted ? "host-restarted" : "ring",
        requestedFromCursor: cursor,
        oldestCursor: answer.oldestCursor,
      })}\n\n`);
    } else {
      for (const d of answer.deltas) send(d);
      lastSent = answer.deltas.at(-1)?.cursor ?? cursor;
    }
    const held = pending;
    pending = null;
    for (const d of held) if (d.cursor > lastSent) send(d);

    if (closed) return;
    offClose = structured.onClose(cleanup);
    heartbeat = setInterval(() => {
      if (!structured.ready()) cleanup();
      else if (structured.page(paneId) === undefined) {
        write(`event: ended\ndata: ${JSON.stringify({ paneId })}\n\n`);
        cleanup();
      } else write(": ping\n\n");
    }, heartbeatMs);

    function cleanup(): void {
      if (closed) return;
      closed = true;
      unsubscribe();
      offClose();
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
    req.on("close", cleanup);
    res.on("error", cleanup);
  };
}

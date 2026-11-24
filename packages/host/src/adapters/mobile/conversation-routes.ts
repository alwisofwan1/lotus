import type { IncomingMessage, ServerResponse } from "node:http";

import type { ApiClient } from "../../core/api-client.js";
import { ApiError } from "../../core/api-error.js";
import type { Router } from "../../server/router.js";
import type { ConversationPage } from "../../types/conversation.js";
import type { FleetMember } from "../../types/fleet.js";
import type { TranscriptResponse } from "../../types/transcript.js";
import { turnsFromEntries } from "./conversation/parts-from-entries.js";
import { runnerTranscriptCaps } from "./conversation/runner-caps.js";
import type { Device } from "./device-store.js";
import { pageQuery, send } from "./http-util.js";
import type { StructuredSessions } from "./structured/structured-sessions.js";

export interface ConversationRouteDeps {
  api: Pick<ApiClient, "readCellTranscript">;
  fleetSnapshot: () => Promise<FleetMember[]>;
  /** Cells this host runs itself: their page is native and served from memory. */
  structured?: StructuredSessions;
  guarded: (
    handler: (ctx: { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; device: Device }) => Promise<void>,
  ) => (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;
}

/**
 * `GET /m/cell/:paneId/conversation` — the same page `/transcript` serves, as turns of
 * typed parts with per-runner capabilities beside them (`types/conversation.ts`).
 *
 * Built **on** the transcript read rather than beside it: the desktop is still the only
 * process that reads a runner's file, and this route asks it the same question and
 * reshapes the answer. `before` / `limit` are forwarded verbatim for that reason, and the
 * cursor comes back untouched — an index into the same list.
 *
 * A desktop without the transcript route (404) answers the way `/transcript` does:
 * `hostSupports: false`, no turns, every capability `never`. Never a 404 to the phone.
 */
export function addConversationRoutes(router: Router, deps: ConversationRouteDeps): void {
  router.add("GET", "/m/cell/:paneId/conversation", deps.guarded(async ({ req, res, params }) => {
    const paneId = params["paneId"] ?? "";
    const native = deps.structured?.page(paneId);
    if (native !== undefined) return send(res, 200, native);
    const member = (await deps.fleetSnapshot()).find((m) => m.paneId === paneId);
    let transcript: TranscriptResponse | undefined;
    try {
      transcript = await deps.api.readCellTranscript(paneId, pageQuery(req));
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    send(res, 200, conversationPage(paneId, member, transcript));
  }));
}

/** Pure, so the fixture test and the route agree by construction. */
export function conversationPage(
  paneId: string,
  member: FleetMember | undefined,
  transcript: TranscriptResponse | undefined,
): ConversationPage {
  const runner = member?.agentType ?? "unknown";
  if (transcript === undefined) {
    return {
      paneId,
      runner,
      ...(member?.runnerLabel === undefined ? {} : { runnerLabel: member.runnerLabel }),
      capabilities: runnerTranscriptCaps(undefined),
      source: "ring",
      turns: [],
      hasMore: false,
      hostSupports: false,
    };
  }
  const source = transcript.source ?? "ring";
  const page: ConversationPage = {
    paneId,
    runner,
    ...(member?.runnerLabel === undefined ? {} : { runnerLabel: member.runnerLabel }),
    // `never` across the board when the desktop itself says none is coming — the table
    // describes a runner that reports, and this pane's does not.
    capabilities: transcript.transcriptOutlook === "never" ? runnerTranscriptCaps(undefined) : runnerTranscriptCaps(runner),
    source,
    turns: turnsFromEntries(transcript.entries, source === "file" ? "derived" : "hook"),
    hasMore: transcript.hasMore ?? false,
  };
  if (transcript.oldestCursor !== undefined) page.oldestCursor = transcript.oldestCursor;
  if (transcript.totalEver !== undefined) page.totalEver = transcript.totalEver;
  if (transcript.hostSupports !== undefined) page.hostSupports = transcript.hostSupports;
  if (transcript.transcriptOutlook !== undefined) page.transcriptOutlook = transcript.transcriptOutlook;
  return page;
}

import type { ServerResponse } from "node:http";

import { AttachmentRefused, checkAttachments, type ChatAttachmentStore } from "../../core/chat-attachments.js";
import type { ChatActionResult } from "../../types/conversation.js";
import type { PromptAttachment } from "../../types/provider-bridge.js";
import { permissionModeIds } from "./spawn-tuning.js";
import { spawnHeadlessCell, type HeadlessSpawnDeps } from "./structured/headless-spawn.js";
import type { StructuredSessions } from "./structured/structured-sessions.js";

const PERMISSION_MODES = new Set<string>(permissionModeIds());

export interface ChatActionDeps extends Omit<HeadlessSpawnDeps, "structured"> {
  structured: StructuredSessions;
  /** Copies uploaded from another machine; absent, `send` refuses attachments. */
  attachments?: ChatAttachmentStore;
}

export type ChatAct = (action: string, body: Record<string, unknown>) => Promise<ChatActionResult>;

const ok = (body: Record<string, unknown> = { ok: true }): ChatActionResult => ({ status: 200, body });
const fail = (status: number, error: string): ChatActionResult => ({ status, body: { ok: false, error } });

function text(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t;
}

/** Captures what `spawnHeadlessCell` answers, so the phone's spawn path serves `/v1` unchanged. */
async function spawn(body: Record<string, unknown>, deps: HeadlessSpawnDeps): Promise<ChatActionResult> {
  const out: ChatActionResult = { status: 500, body: {} };
  const res = {
    writeHead: (status: number) => { out.status = status; },
    end: (raw: string) => { out.body = JSON.parse(raw) as Record<string, unknown>; },
  } as unknown as ServerResponse;
  const initialPrompt = typeof body["initialPrompt"] === "string" ? body["initialPrompt"] : undefined;
  const opt = (k: string, v: string | undefined) => (v === undefined ? {} : { [k]: v });
  await spawnHeadlessCell(res, {
    provider: text(body["provider"]) ?? "",
    workspaceId: text(body["workspaceId"]),
    ...opt("initialPrompt", initialPrompt),
    ...opt("permissionMode", text(body["permissionMode"])),
    ...opt("model", text(body["model"])),
    ...opt("effort", text(body["effort"])),
    ...opt("profileId", text(body["profileId"])),
  }, deps);
  return out;
}

/** The headless-cell actions the desktop Chat drives over `/v1`, with the phone routes' rules. */
export function chatActions(deps: ChatActionDeps): ChatAct {
  const { structured } = deps;
  return async (action, body) => {
    if (action === "spawn") {
      if (text(body["provider"]) === undefined) return fail(400, "provider is required");
      const mode = text(body["permissionMode"]);
      if (mode !== undefined && !PERMISSION_MODES.has(mode)) {
        return fail(400, `permissionMode must be one of ${[...PERMISSION_MODES].join(", ")}`);
      }
      return spawn(body, deps);
    }

    const paneId = text(body["pane_id"]) ?? "";
    if (!["send", "answer", "stop", "posture", "close", "permission"].includes(action)) {
      return fail(404, `unknown chat action "${action}"`);
    }
    if (!structured.has(paneId)) return fail(404, "no headless cell with that paneId on this host");

    switch (action) {
      case "send": {
        const message = typeof body["text"] === "string" ? body["text"] : "";
        let attached: PromptAttachment[] = [];
        if (body["attachments"] !== undefined) {
          if (deps.attachments === undefined) return fail(400, "this host cannot take attachments; update lotus-host");
          const cwd = structured.list().find((m) => m.paneId === paneId)?.cwd;
          try {
            attached = checkAttachments(body["attachments"], [deps.attachments.root, ...(cwd ? [cwd] : [])]);
          } catch (err) {
            if (err instanceof AttachmentRefused) return fail(err.status, err.message);
            throw err;
          }
        }
        if (message.trim().length === 0 && attached.length === 0) return fail(400, "text is required");
        const sent = await structured.dispatch(paneId, message, attached);
        if (sent === "blocked") return fail(409, "This cell is waiting for an approval, not a message");
        if (sent !== "sent") return fail(404, "the cell is no longer running");
        deps.attachments?.markSent(attached.map((a) => a.path));
        return ok();
      }
      case "answer": {
        const data = text(body["data"]);
        if (data === undefined) return fail(400, "data is required");
        return structured.input(paneId, data) ? ok() : fail(409, "nothing is waiting for an answer on this cell");
      }
      case "stop":
        return (await structured.stop(paneId)) ? ok() : fail(404, "no headless cell with that paneId on this host");
      case "posture": {
        const mode = text(body["mode"]);
        if (mode === undefined || !PERMISSION_MODES.has(mode)) {
          return fail(400, `mode must be one of ${[...PERMISSION_MODES].join(", ")}`);
        }
        return (await structured.setPosture(paneId, mode)) ? ok({ ok: true, mode }) : fail(409, "this cell's posture cannot be changed while it runs");
      }
      case "close":
        return structured.close(paneId) ? ok({ ok: true, paneId }) : fail(404, "no headless cell with that paneId on this host");
      default: {
        const report = structured.permission(paneId);
        return report === undefined ? fail(404, "no headless cell with that paneId on this host") : ok({ ...report });
      }
    }
  };
}

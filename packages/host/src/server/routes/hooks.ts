import type { RouteHandler } from "../router.js";
import { readBody } from "./utils.js";
import { sendJson } from "./fleet.js";
import { awaitingPermission, type HookTurn } from "../../adapters/mobile/hooks/turns.js";
import { promptTail } from "../../adapters/mobile/permission/tail.js";
import { parseCliHookPayload, type CliHookSource } from "../../adapters/mobile/hooks/cli-payload.js";
import { spokenReadback } from "../../adapters/mobile/permission/prompt.js";

/**
 * `POST /v1/hook/turn` — what a hook script says about a pane, in one call.
 *
 * The second producer into the turn map, and the one that needs nothing installed: the desktop
 * has used exactly this shape since `plans/honest-agent-status/` — a shell hook that `curl`s the
 * host, guarded on `$LOTUS_PANE_ID`. The drop-file watcher (`adapters/mobile/hooks/`) is the other
 * producer, and it carries the rich payload Fase 3 needs. Both land in one place so neither caller
 * has to remember the other exists.
 *
 * Why a shell `curl` and not the node hook script here: ADR-F ships this host as a single binary
 * with no node on the target, and a hook that needs node would make TUI permission depend on a
 * runtime the artifact deliberately dropped. This path needs `sh` and `curl`, which a VPS has.
 */
export interface HookTurnSink {
  /** Records what a pane's hooks last said. */
  recordTurn(paneId: string, status: string, atMs: number): void;
}

/** Statuses a hook may report, from `drop-file-schema.md`'s canonical mapping. */
const STATUSES = new Set(["idle", "needs-input", "error", "running", "ended"]);

/** Enough of the turn map for the read side — see `adapters/mobile/hooks/turns.ts`. */
export interface HookTurnSource {
  statusOf(paneId: string): HookTurn | undefined;
}

/**
 * Enough of `PtyManager` to read a pane's **screen** — what the terminal drew, not what the
 * process wrote.
 *
 * The two are not the same thing and the difference is not cosmetic. A TUI moves the cursor
 * instead of printing newlines and jumps columns instead of printing spaces, so the raw stream
 * with its escapes stripped delivered a whole permission prompt as one line reading
 * `Doyouwanttocreategate17.txt?` on `devbox-vps` (`issues/17`). `undefined` means no live
 * session; an empty `text` means the session is there and nothing could be read off it.
 *
 * `columns` comes along because a wrapped label cannot be put back together without knowing
 * where the rows ended.
 */
export interface PaneScreen {
  screenOf(paneId: string): Promise<{ text: string; columns: number } | undefined>;
}

/**
 * `GET /api/fleet/:paneId/permission` — what a cell is asking, and which answers it offers.
 *
 * The two signals meet here (ADR-8). `awaiting` comes from the hook: it is the only thing that
 * knows a prompt was raised rather than merely printed. `prompt` comes from the terminal, because
 * the hook knows a prompt happened and not what it offered — and the digits differ per tool, so a
 * guessed one approves the thing the operator meant to refuse.
 */
export function cellPermissionHandler(turns: HookTurnSource, panes: PaneScreen): RouteHandler {
  return async (_req, res, params): Promise<void> => {
    const paneId = params["paneId"] ?? "";
    const screen = await panes.screenOf(paneId);
    if (screen === undefined) {
      // No live session. Not `awaiting: false` — this host cannot tell, and saying "not waiting"
      // about a pane it cannot see is a claim it has no basis for.
      sendJson(res, 200, { paneId, hostSupports: false, awaiting: false, prompt: null });
      return;
    }

    const answer = awaitingPermission(turns.statusOf(paneId), screen.text, screen.columns);
    sendJson(res, 200, {
      paneId,
      hostSupports: true,
      awaiting: answer.awaiting,
      prompt: answer.prompt,
      ...(answer.prompt === null ? {} : { readback: spokenReadback(answer.prompt) }),
      // Only where the options could not be named. With a prompt the card already has the
      // words; without one, this is the difference between a dead end and a question the
      // operator can read.
      ...(answer.awaiting && answer.prompt === null
        ? { tail: promptTail(screen.text) ?? "" }
        : {}),
    });
  };
}

/** Where a pane's CLI keeps its own history, as the CLI reported it (slice 3.1). */
export interface CliSourceSink {
  record(paneId: string, source: CliHookSource): void;
}

/**
 * `POST /v1/hook/turn` — what a cell's hooks say about it.
 *
 * The body is the **CLI's own payload, forwarded byte for byte**, with Lotus's two facts in
 * headers beside it. That split is deliberate. The path to a runner's transcript exists only
 * inside the CLI's payload, and re-encoding that payload inside a `sh` script is where this
 * project has already lost two escaping bugs — so the script stops building JSON and pipes what
 * it was given.
 *
 * The older body-only shape is still accepted, because the scripts already written to disk keep
 * firing until the installer next runs over them.
 */
/**
 * A header value, or nothing.
 *
 * Control characters are refused rather than stripped. These two values are written by Lotus's
 * own script from `LOTUS_PANE_ID`, so anything shaped otherwise did not come from where it
 * claims, and a pane id is a map key — a mangled one silently addresses the wrong cell.
 */
function header(req: { headers: Record<string, unknown> }, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value !== "string") return undefined;
  if (/[\u0000-\u001f\u007f]/.test(value)) return "";
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

export function hookTurnHandler(
  sink: HookTurnSink,
  sources?: CliSourceSink,
  /**
   * Told after the turn is recorded, so a pane's new steps can be pushed to a watching phone
   * instead of waiting for a pull-to-refresh (slice 3.6).
   */
  onTurn?: (paneId: string) => void,
): RouteHandler {
  return async (req, res): Promise<void> => {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      // 200, not 400. A hook that sees an error status is a hook whose author is tempted to
      // retry or fail the tool call, and a `PreToolUse` hook exiting non-zero BLOCKS the tool.
      // Nothing this endpoint can say is worth that, so it always answers ok and logs nothing.
      sendJson(res, 200, { ok: false, reason: "invalid body" });
      return;
    }

    let body: { pane_id?: string; status?: string; at_ms?: number; message?: unknown; notification_type?: unknown } = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as typeof body;
      }
    } catch {
      // An unparseable body is not fatal any more: the headers may still carry the turn, and
      // the turn is the half that gates approvals. Losing a transcript path costs a Chat page;
      // losing the turn costs the approval.
    }

    const paneId = header(req, "x-lotus-pane-id")
      ?? (typeof body.pane_id === "string" ? body.pane_id.trim() : "");
    if (paneId.length === 0) {
      sendJson(res, 200, { ok: false, reason: "pane_id is required" });
      return;
    }

    const status = header(req, "x-lotus-status")
      ?? (typeof body.status === "string" ? body.status.trim() : "");
    if (!STATUSES.has(status)) {
      // An unknown status is dropped rather than stored: `awaitingPermission` reads this value,
      // and a stray one would sit in the map claiming something nobody defined.
      sendJson(res, 200, { ok: false, reason: "unknown status" });
      return;
    }

    if (status === "needs-input" && !asksTheOperator(body)) {
      // Information, not a question: recorded as needs-input it draws a PERMISSION card and a push.
      sendJson(res, 200, { ok: false, reason: "not a question" });
      return;
    }

    // The hook's own clock is not trusted for ordering — a skewed one would make a turn look
    // older than the TTL and vanish, or newer than now and never age out.
    const at = typeof body.at_ms === "number" && Number.isFinite(body.at_ms) ? body.at_ms : Date.now();
    sink.recordTurn(paneId, status, at);

    // Recorded after the turn, and never allowed to affect it: a payload we cannot read is a
    // Chat page missing, not an approval missing.
    const source = parseCliHookPayload(raw);
    if (source !== undefined) sources?.record(paneId, source);

    // Last, and never allowed to fail the call: publishing steps is what makes Chat move, but a
    // hook that sees an error is a hook whose author blocks the tool.
    try {
      onTurn?.(paneId);
    } catch {
      // A pane whose transcript could not be read this instant is one whose steps arrive on the
      // next fire, or on a refresh. Neither is worth a non-zero exit.
    }

    sendJson(res, 200, { ok: true, paneId, status });
  };
}

/** Claude 2.1.329 notification types that wait on this pane's operator; its other 10 types only inform. */
const ASKING_TYPES = new Set(["permission_prompt", "worker_permission_prompt", "elicitation_dialog", "elicitation_url_dialog"]);

/** An older Claude sends no type: only its idle wording is known to be a notice, the rest fails towards alerting. */
function asksTheOperator(body: { message?: unknown; notification_type?: unknown }): boolean {
  if (typeof body.notification_type === "string") return ASKING_TYPES.has(body.notification_type);
  return !(typeof body.message === "string"
    && body.message.trim().toLowerCase() === "claude is waiting for your input");
}

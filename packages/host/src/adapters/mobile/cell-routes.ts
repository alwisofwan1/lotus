import type { IncomingMessage, ServerResponse } from "node:http";

import type { ApiClient } from "../../core/api-client.js";
import type { AuditEvent, Fields } from "../../core/logger.js";
import type { FleetMember } from "../../types/fleet.js";
import { ApiError } from "../../core/api-error.js";
import type { Router } from "../../server/router.js";
import type { Device } from "./device-store.js";
import { body_, pageQuery, send, sendUpstream, str, type GuardedRoute } from "./http-util.js";
import { permissionModeIds } from "./spawn-tuning.js";
import { spawnHeadlessCell } from "./structured/headless-spawn.js";
import type { StructuredSessions } from "./structured/structured-sessions.js";
import { addCellReadRoutes } from "./cell-read-routes.js";
import { addCellSizeRoutes } from "./cell-size-routes.js";

/** ESC — interrupts the agent's current turn without killing the session (ADR-8). */
export const INTERRUPT_SEQUENCE = "\u001b";

/**
 * Longest body `/input` accepts. A key press is a handful of bytes; a bracketed paste of
 * a command line is a few hundred. Past this it is output being sent back where it came
 * from, or a client that meant `/dispatch`.
 */
export const MAX_INPUT_CHARS = 4096;

export interface CellRouteDeps {
  profiles?: () => readonly { id: string }[]; // see `HeadlessSpawnDeps.profiles`
  api: ApiClient;
  audit: (event: AuditEvent, fields?: Fields) => void;
  /** Current fleet, used to resolve a paneId to the session behind it. */
  fleetSnapshot: () => Promise<FleetMember[]>;
  /**
   * Says a pane just received input, so the output tail reads it quickly for a moment.
   *
   * Here rather than inferred by the tail: that class sees output, and *somebody typed*
   * is not a question output can answer — a pane printing on its own looks the same.
   */
  onInput?: (paneId: string) => void;
  /** A phone sent this pane an ask — `/m/cells` with a prompt, or `/dispatch` (`issues/04`). */
  onAsk?: (paneId: string) => void;
  /**
   * Cells this host runs itself, with no terminal (`tui: false` on `POST /m/cells`). Every
   * route here asks it first: a structured pane is answered from memory, a desktop pane goes
   * to the desktop as before. Absent when the host cannot run one.
   */
  structured?: StructuredSessions;
  /** The bearer check every route here shares, supplied by the main router. */
  guarded: GuardedRoute;
}

/**
 * `/m/cell/:paneId/*` — everything that acts on one agent: what it is told, what it is
 * shown asking, and whether it goes on existing.
 *
 * Its own module for the reason `device-routes.ts` is: `http-routes.ts` reached the
 * 300-line limit when closing a cell arrived, and the seam was already there. What is
 * left behind is pairing, the bootstrap read, dictation, and tasks.
 */
/**
 * What the phone may ask for, so a typo cannot become a posture — the legacy pair plus every
 * stop this host advertises, from the one place both are defined ({@link permissionModeIds}).
 *
 * Coarse on purpose: it catches a typo, not a mismatch. Whether `read-only` makes sense *for
 * the runner being spawned* is a judgement only the machine that owns the registry can make.
 */
const PERMISSION_MODES = new Set<string>(permissionModeIds());

export function addCellRoutes(router: Router, deps: CellRouteDeps): void {
  const { guarded } = deps;

  /**
   * Starts a cell. `POST /m/cells` — the collection, because this creates a member of
   * it; every other route here names one pane.
   *
   * `permissionMode` is validated and forwarded rather than defaulted. A host that
   * quietly picked one would be answering a question the operator was shown and asked,
   * and the whole reason the field exists is that a running cell cannot be turned back
   * (ADR-8).
   */
  router.add("POST", "/m/cells", guarded(async ({ req, res, device }) => {
    const body = await body_(req, res);
    if (body === undefined) return;
    const provider = str(body["provider"]);
    if (provider === undefined || provider.trim().length === 0) {
      return send(res, 400, { error: "provider is required" });
    }
    const mode = str(body["permissionMode"]);
    if (mode !== undefined && !PERMISSION_MODES.has(mode)) {
      return send(res, 400, {
        error: `permissionMode must be one of ${[...PERMISSION_MODES].join(", ")}`,
      });
    }

    const workspaceId = str(body["workspaceId"]);
    const initialPrompt = str(body["initialPrompt"]);
    // Free text on purpose: it names a runner the operator defined, so the only place
    // it can be checked is the registry on the machine that will launch it.
    const runnerId = str(body["runnerId"]);
    // Free text too: `bootstrap.runners[]` told the phone what this machine accepts, and the
    // CLI is the only thing that can finally judge an alias. An empty string is *nothing
    // chosen*, and is dropped rather than sent as a flag with no value.
    const model = nonEmpty(str(body["model"]));
    const effort = nonEmpty(str(body["effort"]));
    // Free text too, and checked against the machine rather than against a list here: only
    // the host that will launch it knows which accounts it is logged into.
    const profileId = nonEmpty(str(body["profileId"]));
    // `tui: false` — run it here, over the runner's structured protocol, with no terminal.
    if (body["tui"] === false) {
      const spawned = await spawnHeadlessCell(res, {
        provider, workspaceId,
        ...(initialPrompt === undefined ? {} : { initialPrompt }),
        ...(mode === undefined ? {} : { permissionMode: mode }),
        ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }),
        ...(profileId === undefined ? {} : { profileId }),
      }, deps);
      if (spawned !== undefined) {
        deps.audit("cell.spawned", { deviceId: device.deviceId, provider, permissionMode: mode ?? "", model: model ?? "", effort: effort ?? "", profileId: profileId ?? "", tui: "false" });
      }
      return;
    }
    try {
      const spawned = await deps.api.spawnCell({
        provider,
        ...(runnerId === undefined ? {} : { runnerId }),
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(initialPrompt === undefined ? {} : { initialPrompt }),
        ...(mode === undefined ? {} : { permissionMode: mode }),
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(profileId === undefined ? {} : { profileId }),
      });
      if (initialPrompt !== undefined) deps.onAsk?.(spawned.paneId);
      deps.audit("cell.spawned", {
        deviceId: device.deviceId,
        provider,
        permissionMode: mode ?? "",
        model: model ?? "",
        effort: effort ?? "",
        profileId: profileId ?? "",
      });
      send(res, 200, spawned);
    } catch (err) {
      // Every refusal the desktop *states* reaches the phone ({@link sendUpstream}); only
      // 503 did until 2026-08-27, and a 400 naming `permissionMode` died as a bare 500.
      if (sendUpstream(res, err)) return;
      throw err;
    }
  }));

  router.add("POST", "/m/cell/:paneId/dispatch", guarded(async ({ req, res, params, device }) => {
    const body = await body_(req, res);
    if (body === undefined) return;
    const text = str(body["text"]);
    if (text === undefined || text.trim().length === 0) {
      return send(res, 400, { error: "text is required" });
    }
    const paneId = params["paneId"] ?? "";
    // `blocked` is named rather than swallowed: the cell is holding a question, and a
    // sentence is not an answer to it — `/input` is the route that decides.
    const structured = await deps.structured?.dispatch(paneId, text);
    if (structured === "blocked") return send(res, 409, { error: "This cell is waiting for an approval, not a message" });
    if (structured !== "sent") await deps.api.dispatchToCell({ paneId, command: text });
    deps.onAsk?.(paneId);
    deps.audit("dispatch.executed", { deviceId: device.deviceId, paneId });
    send(res, 200, { ok: true });
  }));

  /**
   * Writes bytes to the pane's PTY **exactly as given** — no submit key appended.
   *
   * The difference from `/dispatch` is the whole point. Dispatch is *a sentence for the
   * agent*: it strips the trailing newline, pauses, then sends CR separately, because a
   * TUI swallows a paste that carries its own Enter (`build_dispatch_write_plan`, and
   * the 2026-08-06 measurement behind it). This route is *a key press*. `Ctrl-C` is one
   * byte with no line to submit, `↑` is three, and typing `l` must not become a line.
   *
   * Nothing here interprets the bytes. The phone's emulator already encodes them — it
   * knows the pane's cursor-key mode because it is drawing the same stream — so a
   * second opinion on this side could only ever disagree with the first.
   *
   * Capped because the body is a key press, not a paste: anything larger is either a
   * mistake or a client using the wrong route.
   */
  router.add("POST", "/m/cell/:paneId/input", guarded(async ({ req, res, params, device }) => {
    const body = await body_(req, res);
    if (body === undefined) return;
    const data = str(body["data"]);
    if (data === undefined || data.length === 0) {
      return send(res, 400, { error: "data is required" });
    }
    if (data.length > MAX_INPUT_CHARS) {
      return send(res, 400, { error: `data is longer than ${MAX_INPUT_CHARS} characters` });
    }

    const paneId = params["paneId"] ?? "";
    if (deps.structured?.has(paneId)) {
      // The only keys a structured cell knows are a pending permission's digits.
      if (!deps.structured.input(paneId, data)) return send(res, 409, { error: "nothing is waiting for a key on this cell" });
      deps.audit("cell.input", { deviceId: device.deviceId, paneId, bytes: data.length });
      return send(res, 200, { ok: true });
    }
    const cell = (await deps.fleetSnapshot()).find((c) => c.paneId === paneId);
    if (!cell?.sessionId) return send(res, 404, { error: `No live session for pane ${paneId}` });

    await deps.api.writeToSession(cell.sessionId, data);
    // The echo is the whole felt latency of a keystroke, and it arrives on the tail's
    // next read — so tell the tail there is something to come back for.
    deps.onInput?.(paneId);
    // Byte count, never the bytes. A keystroke audit that recorded what was typed would
    // be a keylogger with a good excuse, and this trail is read by whoever holds the
    // machine — not only by the person at the phone.
    deps.audit("cell.input", { deviceId: device.deviceId, paneId, bytes: data.length });
    send(res, 200, { ok: true });
  }));

  /**
   * Moves a running cell's posture. `POST /m/cell/:paneId/posture`.
   *
   * The stop used to be fixed for the life of a cell — `--permission-mode` is a spawn flag, so
   * loosening one meant killing it and losing the conversation, and on a phone that is realised
   * only after the agent is half done. Probed 2026-09-09: Claude takes it back over its control
   * channel, and the runner keeps deciding what the mode means.
   *
   * **409 rather than 200 when it could not move**, and the difference is the whole point: a
   * cell with no bridge behind it, or a runner that cannot be asked, must not answer the phone
   * with a posture it is not on. That is the failure this route exists to avoid, and it is the
   * same one `/input` learned the hard way (`structured-sessions.ts`).
   */
  router.add("POST", "/m/cell/:paneId/posture", guarded(async ({ req, res, params, device }) => {
    const body = await body_(req, res);
    if (body === undefined) return;
    const mode = str(body["mode"]);
    if (mode === undefined || !PERMISSION_MODES.has(mode)) {
      return send(res, 400, { error: `mode must be one of ${[...PERMISSION_MODES].join(", ")}` });
    }
    const paneId = params["paneId"] ?? "";
    if (!(await deps.structured?.setPosture(paneId, mode))) {
      return send(res, 409, { error: "this cell's posture cannot be changed while it runs" });
    }
    deps.audit("cell.posture", { deviceId: device.deviceId, paneId, mode });
    send(res, 200, { ok: true, mode });
  }));

  router.add("POST", "/m/cell/:paneId/stop", guarded(async ({ res, params, device }) => {
    const paneId = params["paneId"] ?? "";
    if (await deps.structured?.stop(paneId)) {
      deps.audit("cell.stopped", { deviceId: device.deviceId, paneId });
      return send(res, 200, { ok: true });
    }
    const cell = (await deps.fleetSnapshot()).find((c) => c.paneId === paneId);
    if (!cell?.sessionId) return send(res, 404, { error: `No live session for pane ${paneId}` });

    await deps.api.writeToSession(cell.sessionId, INTERRUPT_SEQUENCE);
    deps.audit("cell.stopped", { deviceId: device.deviceId, paneId });
    send(res, 200, { ok: true });
  }));

  /**
   * Ends a cell. `DELETE` on the pane itself, because this is about the pane existing
   * rather than about something happening inside it.
   *
   * The 503 the desktop answers when its window is not on a workspace is passed
   * through untouched: it is the one refusal the operator can act on, and rewording it
   * as a fault would send them looking for a broken machine.
   */
  router.add("DELETE", "/m/cell/:paneId", guarded(async ({ res, params, device }) => {
    const paneId = params["paneId"] ?? "";
    if (deps.structured?.close(paneId)) {
      deps.audit("cell.closed", { deviceId: device.deviceId, paneId });
      return send(res, 200, { ok: true, paneId });
    }
    try {
      await deps.api.closeCell(paneId);
    } catch (err) {
      // Same rule as the spawn above: what the desktop refuses, it refuses out loud.
      if (sendUpstream(res, err)) return;
      throw err;
    }
    deps.audit("cell.closed", { deviceId: device.deviceId, paneId });
    send(res, 200, { ok: true, paneId });
  }));

  addCellReadRoutes(router, deps);
  addCellSizeRoutes(router, deps);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

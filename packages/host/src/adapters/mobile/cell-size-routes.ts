import type { Router } from "../../server/router.js";
import type { CellRouteDeps } from "./cell-routes.js";
import { body_, send, sendUpstream } from "./http-util.js";

/** Widest and tallest a phone may ask for. A phone is a few hundred columns at most. */
const MAX_COLS = 500;
const MAX_ROWS = 300;

/**
 * `/m/cell/:paneId/size` — the phone draws a pane at its own size while Terminal is open
 * (ADR-6 addendum 2026-10-05, `plans/lotus-pocket/PLAN.md`).
 *
 * A façade over the desktop's lease (`pty/size_lease.rs`): the rule — who wins, how long a
 * hold lasts, which desktop bytes count as a person — lives on the machine that owns the PTY,
 * because that is where the desktop's own typing is seen. Advertised as `pty-size`, desktop only:
 * a Standalone Host serves no such route on its API.
 */
export function addCellSizeRoutes(router: Router, deps: CellRouteDeps): void {
  const { guarded } = deps;

  router.add("POST", "/m/cell/:paneId/size", guarded(async ({ req, res, params }) => {
    const body = await body_(req, res);
    if (body === undefined) return;
    const cols = whole(body["cols"], MAX_COLS);
    const rows = whole(body["rows"], MAX_ROWS);
    if (cols === undefined || rows === undefined) {
      return send(res, 400, { error: `cols must be 1–${MAX_COLS} and rows 1–${MAX_ROWS}` });
    }
    const token = body["token"];
    if (token !== undefined && typeof token !== "number") {
      return send(res, 400, { error: "token must be a number" });
    }
    const sessionId = await sessionOf(deps, params["paneId"] ?? "");
    if (sessionId === undefined) return send(res, 404, { error: "this cell has no terminal" });
    try {
      const held = await deps.api.holdSessionSize(sessionId, {
        cols, rows, ...(token === undefined ? {} : { token }),
      });
      send(res, 200, held);
    } catch (err) {
      if (sendUpstream(res, err)) return;
      throw err;
    }
  }));

  router.add("POST", "/m/cell/:paneId/size/release", guarded(async ({ req, res, params }) => {
    const body = await body_(req, res);
    if (body === undefined) return;
    const token = body["token"];
    if (typeof token !== "number") return send(res, 400, { error: "token is required" });
    // Nothing to give back on a pane that has gone; the phone is leaving either way.
    const sessionId = await sessionOf(deps, params["paneId"] ?? "");
    if (sessionId !== undefined) {
      try {
        await deps.api.releaseSessionSize(sessionId, token);
      } catch (err) {
        if (sendUpstream(res, err)) return;
        throw err;
      }
    }
    send(res, 200, { ok: true });
  }));
}

/** The PTY behind a pane, or undefined for one with none (a structured cell, a closed pane). */
async function sessionOf(deps: CellRouteDeps, paneId: string): Promise<string | undefined> {
  if (deps.structured?.has(paneId)) return undefined;
  return (await deps.fleetSnapshot()).find((c) => c.paneId === paneId)?.sessionId;
}

function whole(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max
    ? value
    : undefined;
}

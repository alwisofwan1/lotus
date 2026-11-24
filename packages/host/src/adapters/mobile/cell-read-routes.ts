import type { Router } from "../../server/router.js";
import { ApiError } from "../../core/api-error.js";
import type { CellRouteDeps } from "./cell-routes.js";
import { pageQuery, send, sendUpstream } from "./http-util.js";

/**
 * The two routes that **ask a cell what it is saying**, rather than doing something to it.
 *
 * Split out of `cell-routes.ts` when that file crossed the 300-line rule — the same limit that
 * split it out of `http-routes.ts` — and the seam is the one already implicit there: everything
 * left behind changes a cell (start it, prompt it, move its posture, stop it, end it), and
 * everything here only reads one. They fail differently too: a read that cannot be served says
 * so in its own body, where a write that cannot be honoured has to refuse with a status.
 */
export function addCellReadRoutes(router: Router, deps: CellRouteDeps): void {
  const { guarded } = deps;

  router.add("GET", "/m/cell/:paneId/transcript", guarded(async ({ req, res, params }) => {
    // No 404 for an unknown pane: a cell that has recorded nothing is normal, and
    // Chat mode renders "nothing yet" rather than an error.
    const paneId = params["paneId"] ?? "";
    const native = deps.structured?.transcript(paneId);
    if (native !== undefined) return send(res, 200, native);
    const empty = { paneId, total: 0, entries: [], hostSupports: false };
    // Forwarded, not interpreted: this route is a façade, and a cursor it re-derived
    // would be a second opinion about a file only the desktop reads.
    const page = pageQuery(req);
    send(res, 200, await orNotSupported(() => deps.api.readCellTranscript(paneId, page), empty));
  }));

  router.add("GET", "/m/cell/:paneId/permission", guarded(async ({ res, params }) => {
    // A Standalone Host has no hook pipeline at all, so its API has no such route.
    // Answering 500 tells the phone something broke; the truth is that this host
    // cannot know, which `hostSupports: false` says without lying about the cell.
    const native = deps.structured?.permission(params["paneId"] ?? "");
    if (native !== undefined) return send(res, 200, native);
    const empty = { paneId: params["paneId"] ?? "", awaiting: false, prompt: null, hostSupports: false };
    send(res, 200, await orNotSupported(() => deps.api.readCellPermission(params["paneId"] ?? ""), empty));
  }));
}

/**
 * Falls back when the desktop API does not have the route at all (404).
 *
 * Only 404 — every other failure still propagates, because "this host cannot do it"
 * and "this host is broken" must not look the same to the phone.
 */
async function orNotSupported<T>(call: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return fallback;
    throw err;
  }
}

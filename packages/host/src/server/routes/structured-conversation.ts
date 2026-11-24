import type { RouteHandler } from "../router.js";
import type { StructuredFleetRef } from "../structured-fleet-ref.js";
import { readJson } from "./utils.js";

interface Body {
  pane_id?: string;
}

/**
 * `POST /v1/cell-conversation` — a headless cell's turns, for a caller that is not a phone.
 *
 * **Why this exists separately from `read-cell-output`.** That route returns the tail of a
 * pane's terminal, and a `tui: false` cell has no terminal: its runner speaks a structured
 * protocol and the session holds the turns in memory. So a caller that adopted such a cell
 * cannot read it as bytes at all — it has to ask for the conversation, which is what the
 * phone's `GET /m/cell/:paneId/conversation` already does through `structured.page()`.
 *
 * The shape is that route's, untouched: one `ConversationPage`, so a client that already
 * renders the phone's conversation renders this one with no second parser.
 *
 * A pane this host does not run headless answers `ok: false` rather than 404 — the caller
 * asked a reasonable question about a pane that may simply have a terminal instead, and the
 * answer to that is "not here", not "you are wrong".
 */
export function structuredConversationHandler(structured?: StructuredFleetRef): RouteHandler {
  return async (req, res) => {
    const body = await readJson<Body>(req).catch(() => ({} as Body));
    const paneId = typeof body.pane_id === "string" ? body.pane_id.trim() : "";
    if (paneId === "") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "pane_id is required" }));
      return;
    }

    const page = structured?.page(paneId);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(
      page === undefined
        ? { ok: false, error: "no headless cell with that paneId on this host", paneId }
        : { ok: true, ...page },
    ));
  };
}

import type { RouteHandler } from "../router.js";
import type { StructuredFleetRef } from "../structured-fleet-ref.js";
import { readJson } from "./utils.js";

interface Body {
  pane_id?: string;
}

/** Reuse ConversationPage for headless cells because they expose structured turns without terminal bytes. */
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

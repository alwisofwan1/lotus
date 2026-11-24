import type { RouteHandler } from "../router.js";
import { sendJson } from "./fleet.js";
import { readTuiTranscript, type TuiTranscriptDeps } from "../../adapters/mobile/transcript/tui-source.js";

/**
 * `GET /api/fleet/:paneId/transcript` — a TUI cell's Chat page, read from the runner's own file.
 *
 * **Why here and not in the mobile façade.** In standalone mode the façade's `ApiClient` points
 * at this host (`src/index.ts`), and `readCellTranscript` asks for this exact path. Until this
 * route existed it 404'd, and the façade turned that into `hostSupports: false` — which is why a
 * VPS host has never had a Chat page. Serving it here means the façade needs no change at all,
 * and `GET /m/cell/:paneId/conversation` follows for free: it is built on the same read.
 *
 * The desktop serves the same path from its own hook ring and file reader; this is the standalone
 * half of the same contract (slice 3.3).
 */
export interface CellTranscriptDeps extends Omit<TuiTranscriptDeps, "sourceOf"> {
  sources: { sourceOf: TuiTranscriptDeps["sourceOf"] };
}

export function cellTranscriptHandler(deps: CellTranscriptDeps): RouteHandler {
  return async (req, res, params): Promise<void> => {
    const paneId = params["paneId"] ?? "";
    const url = new URL(req.url ?? "/", "http://localhost");
    const page = readTuiTranscript(paneId, {
      ...num(url, "before"),
      ...num(url, "limit"),
    }, { ...deps, sourceOf: (id) => deps.sources.sourceOf(id) });

    // 404 rather than an empty page: this host does not run the pane, so it has no standing to
    // say anything about it. The façade reads exactly this as "cannot know" and answers the phone
    // `hostSupports: false`, which is the honest shape — any other status would say "broken".
    if (page === undefined) {
      sendJson(res, 404, { error: "unknown pane" });
      return;
    }
    sendJson(res, 200, page);
  };
}

function num(url: URL, key: "before" | "limit"): { before?: number } | { limit?: number } {
  const raw = url.searchParams.get(key);
  if (raw === null) return {};
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return {};
  return { [key]: Math.floor(value) };
}

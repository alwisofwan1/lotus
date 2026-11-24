import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { cellTranscriptHandler } from "../transcript.js";

const SESSION = readFileSync(
  join(__dirname, "..", "..", "..", "adapters", "mobile", "transcript", "__tests__", "fixtures", "claude-session.jsonl"),
  "utf8",
);

/**
 * Slice 3.3, and the route lives **here** rather than in the mobile façade for a reason worth
 * writing down: in standalone mode the façade's `ApiClient` points at this host
 * (`src/index.ts` — `new ApiClient(host.url, …)`), and `readCellTranscript` asks for exactly this
 * path. Until now it 404'd, and the façade turned that into `hostSupports: false`.
 *
 * So nothing in the façade changes. `/conversation` follows for free too: it is built on the same
 * read.
 */
function get(url: string, deps: any): Promise<{ status: number; json: any }> {
  const handler = cellTranscriptHandler(deps);
  const req = new EventEmitter() as IncomingMessage;
  req.method = "GET";
  req.url = url;
  req.headers = {};
  return new Promise((resolve) => {
    let status = 0;
    const chunks: string[] = [];
    const res = {
      writeHead(code: number) { status = code; return res; },
      end(chunk?: string) { if (chunk) chunks.push(chunk); resolve({ status, json: JSON.parse(chunks.join("")) }); },
    } as unknown as ServerResponse;
    void handler(req, res, { paneId: "pane-7" });
  });
}

const deps = (over: object = {}) => ({
  sources: { sourceOf: () => ({ transcriptPath: "/t/a.jsonl" }) },
  providerOf: () => "claude",
  readFile: () => ({ ok: true, text: SESSION }),
  ...over,
});

describe("GET /api/fleet/:paneId/transcript", () => {
  it("serves the runner's own file", async () => {
    const res = await get("/api/fleet/pane-7/transcript", deps());

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ paneId: "pane-7", source: "file", totalEver: 6 });
    expect(res.json.entries).toHaveLength(6);
  });

  it("reads before and limit off the query", async () => {
    const res = await get("/api/fleet/pane-7/transcript?before=4&limit=2", deps());

    expect(res.json.entries.map((e: any) => e.event)).toEqual(["tool-post", "tool-pre"]);
    expect(res.json).toMatchObject({ oldestCursor: 2, hasMore: true });
  });

  /**
   * A pane this host does not run gets a 404, and that is deliberate rather than sloppy: the
   * façade turns exactly this into `hostSupports: false` — "this host cannot know" — and any
   * other status would tell the phone something broke.
   */
  it("404s for a pane it does not run, which the façade reads as cannot-know", async () => {
    const res = await get("/api/fleet/pane-7/transcript", deps({ providerOf: () => undefined }));

    expect(res.status).toBe(404);
  });

  it("says nothing yet for a pane whose hooks have not spoken", async () => {
    const res = await get("/api/fleet/pane-7/transcript", deps({ sources: { sourceOf: () => undefined } }));

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ total: 0, entries: [] });
    expect(res.json).not.toHaveProperty("hostSupports");
  });

  it("says there will never be a page for a runner whose format it cannot read", async () => {
    // A claim about this cell, not about this machine — the pane beside it may be a claude
    // cell whose Chat works (`transcript/tui-source.ts`).
    const res = await get("/api/fleet/pane-7/transcript", deps({ providerOf: () => "codex" }));

    expect(res.json).toMatchObject({ transcriptOutlook: "never", total: 0, entries: [] });
    expect(res.json).not.toHaveProperty("hostSupports");
  });
});

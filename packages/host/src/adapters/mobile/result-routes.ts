import type { IncomingMessage, ServerResponse } from "node:http";

import type { ApiClient } from "../../core/api-client.js";
import { ApiError } from "../../core/api-error.js";
import type { Router } from "../../server/router.js";
import type { FleetMember } from "../../types/fleet.js";
import type { Device } from "./device-store.js";
import type { Git } from "../../core/git.js";
import { isSafeRelativePath, listChanges, readDiff } from "./git-changes.js";
import { query, send } from "./http-util.js";

export interface ResultRouteDeps {
  api: ApiClient;
  git: Git;
  fleetSnapshot: () => Promise<FleetMember[]>;
  guarded: (
    handler: (ctx: {
      req: IncomingMessage;
      res: ServerResponse;
      params: Record<string, string>;
      device: Device;
    }) => Promise<void>,
  ) => (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>;
}

/**
 * `/m/cell/:paneId/result` and `/diff` — what the agent left behind, from the disk.
 *
 * The hook ring tells the phone which files an agent *said* it edited; this asks the
 * working tree what actually differs from `HEAD`. Two reasons that is a separate route
 * and not a field on the transcript: it is the only source for a runner that reports
 * nothing (Codex's ring is empty forever), and it is git's answer rather than the
 * agent's — the two disagree exactly when it matters.
 *
 * Base capability, not desktop-only: the host runs on the machine that owns `cwd` in
 * both modes. What it needs from the desktop is only the pane's `cwd`, which the fleet
 * snapshot already carries.
 */
export function addResultRoutes(router: Router, deps: ResultRouteDeps): void {
  const { guarded } = deps;

  router.add("GET", "/m/cell/:paneId/result", guarded(async ({ res, params }) => {
    const paneId = params["paneId"] ?? "";
    const member = (await deps.fleetSnapshot()).find((m) => m.paneId === paneId);
    const cwd = member?.cwd;

    // The agent's closing words, as the ring kept them (clipped at 8000 bytes by the
    // desktop, flagged when so). Absent on a host with no ring, or a pane with no stop.
    const closing = await lastStop(deps.api, paneId);

    if (!cwd) {
      // A pane the fleet does not know, or knows without a directory: nothing to ask
      // git about, and saying so is the whole answer.
      return send(res, 200, { paneId, cwd: null, closing, changes: null, reason: "no_cwd" });
    }
    const changes = await listChanges(deps.git, cwd);
    if ("reason" in changes) {
      return send(res, 200, { paneId, cwd, closing, changes: null, reason: changes.reason });
    }
    const added = changes.files.reduce((n, f) => n + (f.added ?? 0), 0);
    const removed = changes.files.reduce((n, f) => n + (f.removed ?? 0), 0);
    send(res, 200, {
      paneId,
      cwd,
      closing,
      changes: { source: "git", against: "HEAD", files: changes.files, added, removed },
    });
  }));

  router.add("GET", "/m/cell/:paneId/diff", guarded(async ({ req, res, params }) => {
    const paneId = params["paneId"] ?? "";
    const file = query(req, "file") ?? "";
    // Relative and inside the tree, or refused: this string reaches `git` as an argument,
    // and a path that climbs out of `cwd` would read any file the host can.
    if (!isSafeRelativePath(file)) return send(res, 400, { error: "file must be a relative path inside the project" });
    const member = (await deps.fleetSnapshot()).find((m) => m.paneId === paneId);
    if (!member?.cwd) return send(res, 404, { error: `no working directory known for pane ${paneId}` });

    const { diff, truncated } = await readDiff(deps.git, member.cwd, file);
    send(res, 200, { paneId, file, diff, truncated });
  }));
}

/**
 * The last `stop` entry's body, from the transcript the desktop keeps. Null when the
 * host has no ring (Standalone, 404) or the pane has no stop yet — both are "nothing to
 * quote", which the phone already renders from its own copy of the ring.
 */
async function lastStop(
  api: ApiClient,
  paneId: string,
): Promise<{ text: string; truncated: boolean; at: number } | null> {
  try {
    const { entries } = await api.readCellTranscript(paneId, {});
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.event === "stop") return { text: e.body, truncated: e.bodyTruncated === true, at: e.timestamp };
    }
    return null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

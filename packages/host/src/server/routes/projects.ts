import type { IncomingMessage, ServerResponse } from "node:http";
import type { ProjectRegistry } from "../projects/registry.js";
import type { RouteHandler } from "../router.js";
import { readJson } from "./utils.js";
import { sendJson } from "./fleet.js";
import { BrowseRoots, NotBrowsableError, OutsideRootsError } from "../projects/browse.js";
import { AlreadyAProjectError, type ProjectRegistrar } from "../projects/registrar.js";
import {
  CloneTargetExistsError,
  InvalidCloneTargetError,
  type CloneProjectRequest,
  type ProjectCloner,
} from "../projects/clone.js";

export function listProjectsHandler(registry: ProjectRegistry) {
  return (_req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(registry.list()));
  };
}

/**
 * `POST /api/projects/clone` — starts a clone and answers immediately with its id.
 *
 * A request, not a job, is the thing that would otherwise have to wait: a repo over a VPS
 * link takes as long as it takes, and the phone is allowed to leave the screen while it runs
 * (`issues/02`). `cloner` is absent on a host with no workspace root to clone into, and that
 * is a fork rather than a fault — it answers 503, the same way a host without a provider does.
 */
export function cloneProjectHandler(cloner: ProjectCloner | undefined): RouteHandler {
  return async (req, res): Promise<void> => {
    if (cloner === undefined) {
      sendJson(res, 503, { error: "This host has no workspace root to clone into" });
      return;
    }
    let body: CloneProjectRequest;
    try {
      body = await readJson<CloneProjectRequest>(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    if (typeof body.url !== "string" || body.url.trim().length === 0) {
      sendJson(res, 400, { error: "url is required" });
      return;
    }

    try {
      sendJson(res, 200, cloner.start(body));
    } catch (err) {
      // Two refusals a client must tell apart: one asks for a different name, the other
      // says the project is already there.
      if (err instanceof InvalidCloneTargetError) return sendJson(res, 400, { error: err.message });
      if (err instanceof CloneTargetExistsError) return sendJson(res, 409, { error: err.message });
      throw err;
    }
  };
}

/**
 * `GET /api/fs?path=` — one level of a directory this host opens, or the roots themselves.
 *
 * Directories only, never file names and never contents (ADR-A). `roots` rides along on every
 * answer so a client can draw the top level without a second call — and so "my folder is not
 * here" reads as configuration rather than as a broken app.
 */
export function browseHandler(browse: BrowseRoots | undefined): RouteHandler {
  return async (req, res): Promise<void> => {
    if (browse === undefined) {
      sendJson(res, 503, { error: "This host opens no directories for browsing" });
      return;
    }
    const asked = new URL(req.url ?? "/", "http://localhost").searchParams.get("path");
    const roots = browse.roots();
    if (asked === null || asked.length === 0) {
      sendJson(res, 200, { roots, page: null });
      return;
    }
    try {
      sendJson(res, 200, { roots, page: browse.list(asked) });
    } catch (err) {
      // Two refusals a client must tell apart: one is a wall, the other is a wrong turn.
      if (err instanceof OutsideRootsError) return sendJson(res, 403, { error: err.message });
      if (err instanceof NotBrowsableError) return sendJson(res, 404, { error: err.message });
      throw err;
    }
  };
}

/** `GET /api/projects/clone/:taskId` — where that clone got to. */
export function cloneStatusHandler(cloner: ProjectCloner | undefined): RouteHandler {
  return async (_req, res, params): Promise<void> => {
    const job = cloner?.get(params["taskId"] ?? "");
    if (job === undefined) {
      sendJson(res, 404, { error: "Unknown clone task" });
      return;
    }
    sendJson(res, 200, job);
  };
}

/**
 * `POST /api/projects` — takes a directory that is already on the machine (ADR-D).
 *
 * **Nothing is copied.** What changes is this host's claim on a folder that was already there,
 * which is why the answer is the project rather than a job: there is nothing to wait for.
 */
export function addProjectHandler(registrar: ProjectRegistrar | undefined): RouteHandler {
  return async (req, res): Promise<void> => {
    if (registrar === undefined) {
      sendJson(res, 503, { error: "This host does not take folders it did not clone" });
      return;
    }
    let body: { path?: string };
    try {
      body = await readJson<{ path?: string }>(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    if (typeof body.path !== "string" || body.path.trim().length === 0) {
      sendJson(res, 400, { error: "path is required" });
      return;
    }

    try {
      sendJson(res, 201, await registrar.add(body.path));
    } catch (err) {
      // The same three forks browsing already draws, plus the one only this route can hit.
      if (err instanceof OutsideRootsError) return sendJson(res, 403, { error: err.message });
      if (err instanceof NotBrowsableError) return sendJson(res, 404, { error: err.message });
      if (err instanceof AlreadyAProjectError) return sendJson(res, 409, { error: err.message });
      throw err;
    }
  };
}

/**
 * `DELETE /api/projects/:id` — forgets one.
 *
 * The directory is never touched. Idempotent for the same reason closing a cell is: an id this
 * host no longer holds is the state the caller asked for.
 */
export function forgetProjectHandler(registrar: ProjectRegistrar | undefined): RouteHandler {
  return async (_req, res, params): Promise<void> => {
    if (registrar === undefined) {
      sendJson(res, 503, { error: "This host does not take folders it did not clone" });
      return;
    }
    await registrar.remove(params["id"] ?? "");
    sendJson(res, 200, { ok: true });
  };
}

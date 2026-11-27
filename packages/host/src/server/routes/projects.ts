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

/** Return a job ID so clients can leave while a clone runs (issues/02). */
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

/** Expose directories only so browsing cannot reveal file names or contents (ADR-A). */
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

/** Register the existing folder in place so callers need no copy job (ADR-D). */
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

/** Unregistering is idempotent and must leave the directory intact. */
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

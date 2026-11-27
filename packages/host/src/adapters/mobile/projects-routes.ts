import type { Router } from "../../server/router.js";
import type { ApiClient } from "../../core/api-client.js";
import { ApiError } from "../../core/api-error.js";
import type { CloneProjectRequest } from "../../types/index.js";
import { body_, query, send, str, type GuardedRoute } from "./http-util.js";

export interface ProjectRouteDeps {
  api: ApiClient;
  guarded: GuardedRoute;
}

/**
 * `/m/projects/*` — bringing a repository onto the machine the phone is talking to.
 * Every route forwards: this façade owns no filesystem, and `adapters` never imports from
 * `server` (`packages/host/CLAUDE.md`).
 */
export function addProjectRoutes(router: Router, deps: ProjectRouteDeps): void {
  const { guarded } = deps;

  router.add("POST", "/m/projects/clone", guarded(async ({ req, res, device }) => {
    const body = await body_(req, res);
    if (body === undefined) return;
    const url = str(body["url"]);
    if (url === undefined || url.trim().length === 0) {
      return send(res, 400, { error: "url is required" });
    }
    const branch = str(body["branch"]);
    const name = str(body["name"]);
    const ask: CloneProjectRequest = {
      url,
      ...(branch === undefined || branch.length === 0 ? {} : { branch }),
      ...(name === undefined || name.length === 0 ? {} : { name }),
    };
    void device;
    await forward(res, () => deps.api.cloneProject(ask));
  }));

  /**
   * `GET /m/fs?path=` — directories only, inside the roots this host opens (ADR-A).
   * A read, so no gate beyond the bearer: it reveals nothing the bearer does not already reach.
   */
  router.add("GET", "/m/fs", guarded(async ({ req, res }) => {
    const path = query(req, "path");
    await forward(res, () => deps.api.browse(path));
  }));

  /** `POST /m/projects` — takes a folder already on the machine. Nothing is copied. */
  router.add("POST", "/m/projects", guarded(async ({ req, res }) => {
    const body = await body_(req, res);
    if (body === undefined) return;
    const path = str(body["path"]);
    if (path === undefined || path.trim().length === 0) {
      return send(res, 400, { error: "path is required" });
    }
    await forward(res, () => deps.api.addProject(path));
  }));

  /** `DELETE /m/projects/:id` — forgets one. The directory is never touched. */
  router.add("DELETE", "/m/projects/:id", guarded(async ({ res, params }) => {
    await forward(res, () => deps.api.forgetProject(params["id"] ?? ""));
  }));

  router.add("GET", "/m/projects/clone/:taskId", guarded(async ({ res, params }) => {
    await forward(res, () => deps.api.cloneStatus(params["taskId"] ?? ""));
  }));
}

/**
 * Answers with what the machine said, including when it said no. A refusal is never this
 * façade's own: 400 bad folder, 409 taken, 503 no workspace root, 404 older host. Collapsing
 * them into a 500 would help with none of them.
 */
async function forward(
  res: Parameters<typeof send>[0],
  call: () => Promise<unknown>,
): Promise<void> {
  try {
    send(res, 200, await call());
  } catch (err) {
    if (err instanceof ApiError) return send(res, err.status, { error: err.message });
    throw err;
  }
}

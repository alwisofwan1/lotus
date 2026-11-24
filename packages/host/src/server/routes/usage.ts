import type { ServerResponse } from "node:http";

import { InvalidAccountError, UnknownAccountError, type AccountServices } from "../../core/accounts/index.js";
import type { RouteHandler } from "../router.js";
import { readJson } from "./utils.js";

/** What `createApp` is given to serve `/v1/usage` and `/v1/accounts/default`. */
export interface AccountRoutesDeps extends AccountServices {
  /** The name this machine goes by in a grouped usage list. */
  machine: string;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const unavailable = (res: ServerResponse): void => send(res, 503, { error: "accounts are not configured on this host" });

/** `POST /v1/usage` — every account's limits on this machine; no token leaves it. */
export function usageHandler(deps: AccountRoutesDeps | undefined): RouteHandler {
  return async (_req, res) => {
    if (deps === undefined) return unavailable(res);
    send(res, 200, { machine: deps.machine, accounts: await deps.usage.snapshot() });
  };
}

interface DefaultBody { provider?: unknown; id?: unknown }

/** `POST /v1/accounts/default` — which Claude account this host's own spawns run as; null clears. */
export function setDefaultAccountHandler(deps: AccountRoutesDeps | undefined): RouteHandler {
  return async (req, res) => {
    if (deps === undefined) return unavailable(res);
    const body = await readJson<DefaultBody>(req).catch(() => null);
    if (body === null) return send(res, 400, { error: "Invalid JSON body" });
    if (body.provider !== "claude") return send(res, 400, { error: "only provider \"claude\" has a host default" });
    if (body.id !== null && typeof body.id !== "string") return send(res, 400, { error: "id must be a string or null" });
    try {
      deps.defaults.set(body.id);
    } catch (err) {
      if (err instanceof UnknownAccountError) return send(res, 400, { error: err.message });
      throw err;
    }
    send(res, 200, { ok: true });
  };
}

/** `POST /v1/accounts/list` — this machine's Claude accounts, for Settings on another machine. */
export function listAccountsHandler(deps: AccountRoutesDeps | undefined): RouteHandler {
  return async (_req, res) => {
    if (deps === undefined) return unavailable(res);
    send(res, 200, { machine: deps.machine, accounts: await deps.book.list() });
  };
}

/** `POST /v1/accounts/create` `{ name }` — a new, empty Lotus account folder to sign in. */
export function createAccountHandler(deps: AccountRoutesDeps | undefined): RouteHandler {
  return async (req, res) => {
    if (deps === undefined) return unavailable(res);
    const body = await readJson<{ name?: unknown; isolated?: unknown }>(req).catch(() => null);
    if (typeof body?.name !== "string") return send(res, 400, { error: "name must be a string" });
    try {
      send(res, 200, await deps.book.create(body.name, body.isolated === true));
    } catch (err) {
      if (err instanceof InvalidAccountError) return send(res, 400, { error: err.message });
      throw err;
    }
  };
}

/** `POST /v1/accounts/remove` `{ id }` — deletes a Lotus-made account on this host; any other is 400. */
export function removeAccountHandler(deps: AccountRoutesDeps | undefined): RouteHandler {
  return async (req, res) => {
    if (deps === undefined) return unavailable(res);
    const body = await readJson<{ id?: unknown }>(req).catch(() => null);
    if (typeof body?.id !== "string") return send(res, 400, { error: "id must be a string" });
    try {
      send(res, 200, { removed: deps.book.remove(body.id) });
    } catch (err) {
      if (err instanceof InvalidAccountError) return send(res, 400, { error: err.message });
      throw err;
    }
  };
}

/** `POST /v1/accounts/migrate-ccs` `{ action: "plan" | "run" | "remove-mcp" }` — this host off ccs; plan is null without `~/.ccs`. */
export function migrateCcsHandler(deps: AccountRoutesDeps | undefined): RouteHandler {
  return async (req, res) => {
    if (deps === undefined) return unavailable(res);
    const body = await readJson<{ action?: unknown }>(req).catch(() => null);
    const action = body?.action;
    if (action === "plan") return send(res, 200, deps.ccs.plan());
    if (action === "remove-mcp") return send(res, 200, deps.ccs.removeMcp());
    if (action !== "run") return send(res, 400, { error: "action must be plan, run or remove-mcp" });
    if (deps.ccs.plan() === null) return send(res, 400, { error: "this host has no ~/.ccs" });
    send(res, 200, deps.ccs.run());
  };
}

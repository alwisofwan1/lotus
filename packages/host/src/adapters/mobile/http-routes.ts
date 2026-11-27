import type { IncomingMessage, ServerResponse } from "node:http";

import type { ApiClient } from "../../core/api-client.js";
import type { AuditEvent, Fields } from "../../core/logger.js";
import type { FleetMember } from "../../types/fleet.js";
import { ApiError } from "../../core/api-error.js";
import { Router } from "../../server/router.js";
import { addPairRoute } from "./pair-route.js";
import { addCellRoutes } from "./cell-routes.js";
import { addProjectRoutes } from "./projects-routes.js";
import { addConversationRoutes } from "./conversation-routes.js";
import type { StructuredSessions } from "./structured/structured-sessions.js";
import { addDeviceRoutes } from "./device-routes.js";
import { addRenewRoutes } from "./renew-routes.js";
import { type Git, realGit } from "../../core/git.js";
import { addResultRoutes } from "./result-routes.js";
import type { Device, DeviceStore } from "./device-store.js";
import { hostFeatures, MOBILE_PROTOCOL_VERSION, type HostCaps, type HostMode } from "./events.js";
import { body_, bearerOf, query, send, str } from "./http-util.js";
import type { PairingService } from "./pairing.js";
import type { ModelOption } from "../../core/codex-models.js";
import { normalizeProjects } from "./projects-normalize.js";
import { codexModelsFromHome, tuneRunners, type RunnerProfile } from "./spawn-tuning.js";
import { claudeProfiles } from "./structured/bridges/claude/index.js";

export { INTERRUPT_SEQUENCE } from "./cell-routes.js";
export { PAIR_RATE_CAPACITY, PAIR_RATE_MAX_KEYS, PAIR_RATE_REFILL_PER_SEC } from "./pair-route.js";

/**
 * Body cap for `POST /m/stt`, matching the Rust route behind it so an oversized
 * payload is refused here rather than after crossing the loopback hop.
 */
export const STT_MAX_BODY_BYTES = 8 * 1024 * 1024;


export interface MobileHostIdentity {
  hostId: string;
  hostLabel: string;
  mode: HostMode;
}

export interface MobileRouterDeps {
  api: ApiClient;
  devices: DeviceStore;
  pairing: PairingService;
  host: MobileHostIdentity;
  audit: (event: AuditEvent, fields?: Fields) => void;
  /** Current fleet, used to resolve a paneId to the session behind it. */
  fleetSnapshot: () => Promise<FleetMember[]>;
  /** Forwarded to the cell routes — see `CellRouteDeps.onInput`. */
  onInput?: (paneId: string) => void;
  /** Forwarded to the cell routes — see `CellRouteDeps.onAsk`. */
  onAsk?: (paneId: string) => void;

  /** Whether FCM credentials loaded, so `hostCaps` only promises what can be done. */
  pushEnabled?: boolean;
  /** Whether an agent hook is installed — the same discipline, for TUI `permission`. */
  hooks?: boolean;
  /** Whether this host has a workspace root to clone into. Same discipline again. */
  projectsCreate?: boolean;
  /** Whether it opens any directory for browsing, and will take one. Same discipline. */
  projectsBrowse?: boolean;
  /** Cells this host runs itself over a structured protocol — merged into every fleet read. */
  structured?: StructuredSessions;

  /** The Codex models this account may use; defaults to `~/.codex/models_cache.json`. */
  codexModels?: () => ModelOption[];
  /** The Claude accounts this machine is logged into; defaults to a scan of the real dirs. */
  claudeProfiles?: () => RunnerProfile[];
  /** Runs `git` for `/result` and `/diff`; injected by tests, real otherwise. */
  git?: Git;
}

/** Builds the `/m/*` HTTP surface. Every route but `/m/pair` and `/m/devices/renew*` requires a bearer. */
export function buildMobileRouter(deps: MobileRouterDeps): Router {
  const router = new Router();

  addPairRoute(router, deps, () => hostCaps(deps));
  addRenewRoutes(router, { devices: deps.devices, audit: deps.audit });

  const guarded = (
    handler: (ctx: GuardedContext) => Promise<void>,
  ): ((req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => Promise<void>) =>
    async (req, res, params) => {
      const device = authenticate(req, deps);
      if (!device) return send(res, 401, { error: "Unauthorized" });
      await handler({ req, res, params, device });
    };

  router.add("GET", "/m/bootstrap", guarded(async ({ req, res }) => {
    const workspaceId = query(req, "workspaceId");
    const [fleet, workspaces, projects, runners, tasks] = await Promise.all([
      deps.api.listFleet(workspaceId === undefined ? {} : { workspaceId }),
      deps.api.listWorkspaces(),
      // A desktop older than `/api/projects` answers 404, and that is not a broken
      // host — it is one that can only describe what is running. The phone then
      // behaves as it did before ADR-14 rather than failing to start.
      orNotSupported(() => deps.api.listProjects(), { items: [] }),
      // Same shape for the same reason. An empty list here means *this host cannot
      // say*, and the phone falls back to the runners it knows by name rather than
      // showing an operator that their machine has no agents on it.
      orNotSupported(() => deps.api.listRunners(), { items: [] }),
      // And the same again, which it was not until 2026-09-07. A standalone host serves no
      // task API, so an unwrapped call made `GET /m/bootstrap?workspaceId=…` answer 500 —
      // the exact request the phone makes once a project is selected. The unqualified
      // bootstrap worked, which is why it went unseen: the failing branch is the one a real
      // phone takes and the one no test exercised against a host without the route.
      workspaceId === undefined
        ? Promise.resolve({ items: [] })
        : orNotSupported(() => deps.api.listTasks({ workspaceId }), { items: [], total: 0, page: 1, pageSize: 0 }),
    ]);
    send(res, 200, {
      cells: [...fleet.items, ...(deps.structured?.list(workspaceId) ?? [])],
      // What exists, running or not (ADR-14). `workspaces` below is the older,
      // fleet-derived grouping: kept for hosts and clients that still read it, but
      // it cannot represent a project whose agents have all ended.
      projects: normalizeProjects(projects),
      // What the desktop listed, plus what the phone may set on each when it starts
      // one (`spawn-tuning`). The knobs are added here and not in Rust because the
      // model catalogs already live in this package, and they change more often than
      // the desktop ships.
      runners: tuneRunners(
        runners.items,
        deps.codexModels ?? codexModelsFromHome,
        deps.structured?.headlessRunnerRows() ?? [],
        deps.claudeProfiles?.() ?? claudeProfiles(),
      ),
      workspaces: workspaces.items,
      activeTasks: tasks.items,
      hostCaps: hostCaps(deps),
      ...deps.host,
    });
  }));

  /**
   * Dictation. The phone records, this host transcribes with its own key (ADR-11).
   * Bodies are megabytes, so it reads with its own cap rather than raising the default.
   */
  router.add("POST", "/m/stt", guarded(async ({ req, res, device }) => {
    const body = await body_(req, res, STT_MAX_BODY_BYTES);
    if (body === undefined) return;
    const audioBase64 = str(body["audioBase64"]);
    const mime = str(body["mime"]);
    if (audioBase64 === undefined || audioBase64.length === 0 || mime === undefined) {
      return send(res, 400, { error: "audioBase64 and mime are required" });
    }

    // Size, never content: this is the operator's voice, and a byte count is all an
    // audit trail needs to be useful.
    deps.audit("dictation.requested", { deviceId: device.deviceId, bytes: audioBase64.length });

    const prompt = str(body["prompt"]);
    try {
      const result = await deps.api.transcribeAudio({
        audioBase64,
        mime,
        ...(prompt === undefined ? {} : { prompt }),
      });
      send(res, 200, result);
    } catch (err) {
      // Two ways a host says "not here", and both are forks rather than faults: 503
      // when it is configured to transcribe on the device, 404 when it is a desktop
      // older than this route at all. A provider that actually failed keeps its 5xx —
      // the first live smoke run returned exactly that, an OpenAI 400 about the audio,
      // and turning it into a fork would have hidden a real error.
      if (err instanceof ApiError && (err.status === 503 || err.status === 404)) {
        return send(res, 200, { text: null, hostSupports: false });
      }
      throw err;
    }
  }));

  router.add("GET", "/m/tasks", guarded(async ({ req, res }) => {
    const workspaceId = query(req, "workspaceId");
    if (workspaceId === undefined) return send(res, 400, { error: "workspaceId is required" });
    send(res, 200, await deps.api.listTasks({ workspaceId }));
  }));

  router.add("POST", "/m/tasks", guarded(async ({ req, res, device }) => {
    const body = await body_(req, res);
    if (body === undefined) return;
    const workspaceId = str(body["workspaceId"]);
    const title = str(body["title"]);
    const goal = str(body["goal"]);
    if (workspaceId === undefined || title === undefined || goal === undefined) {
      return send(res, 400, { error: "workspaceId, title and goal are required" });
    }
    const task = await deps.api.createTask({ workspaceId, title, goal });
    deps.audit("task.mutated", { deviceId: device.deviceId, action: "create" });
    send(res, 200, task);
  }));

  router.add("PATCH", "/m/tasks/:id", guarded(async ({ req, res, params, device }) => {
    const body = await body_(req, res);
    if (body === undefined) return;
    const workspaceId = str(body["workspaceId"]);
    if (workspaceId === undefined) return send(res, 400, { error: "workspaceId is required" });
    const task = await deps.api.updateTask(params["id"] ?? "", workspaceId, body);
    deps.audit("task.mutated", { deviceId: device.deviceId, action: "update" });
    send(res, 200, task);
  }));

  addCellRoutes(router, {
    api: deps.api,
    audit: deps.audit,
    fleetSnapshot: deps.fleetSnapshot,
    ...(deps.onInput === undefined ? {} : { onInput: deps.onInput }),
    ...(deps.onAsk === undefined ? {} : { onAsk: deps.onAsk }),
    ...(deps.structured === undefined ? {} : { structured: deps.structured }),
    ...(deps.claudeProfiles === undefined ? {} : { profiles: deps.claudeProfiles }),
    guarded,
  });
  addProjectRoutes(router, { api: deps.api, guarded });

  addConversationRoutes(router, {
    api: deps.api, fleetSnapshot: deps.fleetSnapshot, guarded,
    ...(deps.structured === undefined ? {} : { structured: deps.structured }),
  });
  addDeviceRoutes(router, { devices: deps.devices, audit: deps.audit, guarded });
  addResultRoutes(router, {
    api: deps.api,
    git: deps.git ?? realGit,
    fleetSnapshot: deps.fleetSnapshot,
    guarded,
  });

  return router;
}

interface GuardedContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  device: Device;
}

function hostCaps(deps: MobileRouterDeps): HostCaps {
  return {
    protocol: MOBILE_PROTOCOL_VERSION,
    features: hostFeatures(deps.host.mode, {
      push: deps.pushEnabled === true,
      structuredSpawn: deps.structured !== undefined,
      hooks: deps.hooks === true,
      projectsCreate: deps.projectsCreate === true,
      projectsBrowse: deps.projectsBrowse === true,
    }),
  };
}

function authenticate(req: IncomingMessage, deps: MobileRouterDeps): Device | null {
  const bearer = bearerOf(req);
  const device = bearer === undefined ? null : deps.devices.verify(bearer);
  if (!device) {
    deps.audit("auth.rejected", { route: (req.url ?? "").split("?")[0] });
    return null;
  }
  return device;
}

/**
 * Falls back when the desktop API lacks the route (404). Only 404: "cannot do it" and
 * "is broken" must not look the same to the phone.
 */
async function orNotSupported<T>(call: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return fallback;
    throw err;
  }
}


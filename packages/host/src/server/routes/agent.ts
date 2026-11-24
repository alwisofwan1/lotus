import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentRunnerRegistry } from "../agent/registry.js";
import type { PtyManager } from "../pty/manager.js";
import type { ProjectRegistry } from "../projects/registry.js";
import type { RouteHandler } from "../router.js";
import type { AgentProviderId, AgentSpawnRequest } from "../agent/types.js";
import type { CreateSessionRequest } from "../../types/index.js";
import { ProviderUnavailableError } from "../agent/errors.js";
import { spawnCell } from "../agent/spawn-cell.js";
import { readJson } from "./utils.js";

interface SpawnPtyBody {
  provider?: string;
  cwd?: string;
  projectDir?: string;
  project?: string;
  name?: string;
  goal?: string;
  prompt?: string;
  agents?: Array<{ prompt?: string }>;
  cols?: number;
  rows?: number;
  remoteScoped?: boolean;
  /** The posture chosen at summon time — see `AgentSpawnRequest.permissionMode`. */
  permissionMode?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function listProcessesHandler(): RouteHandler {
  return (_req, res): void => {
    sendJson(res, 200, []);
  };
}

export function spawnPtyHandler(
  ptyManager: PtyManager,
  agentRunners: AgentRunnerRegistry,
  projectRegistry: ProjectRegistry,
): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: SpawnPtyBody;
    try {
      body = await readJson<SpawnPtyBody>(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const cwd = resolveCwd(body, projectRegistry);
    if (!cwd) {
      sendJson(res, 400, { error: "cwd, projectDir, or project is required" });
      return;
    }

    const providerStr = body.provider ?? "claude";
    const provider = providerStr as AgentProviderId;
    const runner = agentRunners.get(provider);
    if (!runner) {
      sendJson(res, 400, { error: `Unknown provider: ${providerStr}` });
      return;
    }

    const workspaceId = resolveWorkspaceId(body, cwd, projectRegistry);
    const fleetProvider = toFleetProvider(provider);
    const createReq: CreateSessionRequest = {
      cwd,
      ...(fleetProvider !== undefined ? { provider: fleetProvider } : {}),
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      ...(body.name !== undefined ? { title: body.name } : {}),
      ...(body.cols !== undefined ? { cols: body.cols } : {}),
      ...(body.rows !== undefined ? { rows: body.rows } : {}),
      // Carried into the session, not only into the command line: the fleet has to be able
      // to report this cell's posture long after the spawn (ADR-8, `gatingFor`).
      ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode } : {}),
    };

    const prompt = body.prompt
      ?? body.goal
      ?? body.agents?.find((agent) => agent.prompt)?.prompt;
    const spawnReq: AgentSpawnRequest = {
      cwd,
      provider,
      ...(prompt !== undefined ? { prompt } : {}),
      ...(body.remoteScoped !== undefined ? { remoteScoped: body.remoteScoped } : {}),
      ...(body.permissionMode !== undefined ? { permissionMode: body.permissionMode } : {}),
    };

    try {
      const state = await spawnCell(ptyManager, runner, createReq, spawnReq);
      sendJson(res, 201, {
        ok: true,
        teamId: body.name ?? `standalone-${state.id.slice(0, 8)}`,
        sessionId: state.id,
        workDir: cwd,
        shellCmd: provider,
      });
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        sendJson(res, 503, { error: err.message });
      } else {
        sendJson(res, 500, { error: "Internal server error" });
      }
    }
  };
}

function resolveCwd(body: SpawnPtyBody, projectRegistry: ProjectRegistry): string | null {
  if (body.cwd) return body.cwd;
  if (body.projectDir) return body.projectDir;
  if (!body.project) return null;
  return projectRegistry.get(body.project)?.path ?? null;
}

function resolveWorkspaceId(
  body: SpawnPtyBody,
  cwd: string,
  projectRegistry: ProjectRegistry,
): string | undefined {
  if (body.project) return body.project;
  return projectRegistry.list().find((project) => project.path === cwd)?.id;
}

function toFleetProvider(provider: AgentProviderId): "claude" | "codex" | undefined {
  if (provider === "claude" || provider === "codex") return provider;
  return undefined;
}

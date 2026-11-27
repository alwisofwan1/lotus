import type { RouteHandler } from "../router.js";
import { readJson } from "./utils.js";
import { sendJson } from "./fleet.js";
import type { PtyManager } from "../pty/manager.js";
import { SessionNotFoundError } from "../pty/errors.js";
import type { SpawnCellRequest, SpawnCellResponse } from "../../types/index.js";
import { runnerFamily, runnerProfileId } from "../../core/runner-family.js";
import { spawnConfigDir, UnknownSpawnAccountError, type AccountServices, type SpawnConfigDir } from "../../core/accounts/index.js";
import { spawnCell } from "../agent/spawn-cell.js";
import { ProviderUnavailableError } from "../agent/errors.js";
import type { AgentProviderId } from "../agent/types.js";
import type { AgentRunnerRegistry } from "../agent/registry.js";
import type { ProjectRegistry } from "../projects/registry.js";
import type { WorkerPool } from "../fleet/worker-pool.js";

/** Use the public contract shape for mobile callers, including permissionMode (issues/03). */
export function spawnFleetHandler(
  ptyManager: PtyManager,
  agentRunners: AgentRunnerRegistry,
  projectRegistry: ProjectRegistry,
  workerPool: WorkerPool,
  accounts?: Pick<AccountServices, "claudeAccounts" | "defaults">,
): RouteHandler {
  return async (req, res): Promise<void> => {
    let body: SpawnCellRequest;
    try {
      body = await readJson<SpawnCellRequest>(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    if (!body.provider) {
      sendJson(res, 400, { error: "provider is required" });
      return;
    }

    // `runnerId` names a runner the operator defined; the registry on the machine that
    // launches it is the only place that can judge it (`SpawnCellRequest`).
    const providerId = (body.runnerId ?? body.provider) as AgentProviderId;
    // Legacy `ccs:<name>` runs `claude` on account `<name>` when this host has it (issues/07 slice D).
    const ccsAccount = legacyCcsAccount(providerId, accounts);
    const launchId: AgentProviderId = ccsAccount !== undefined && agentRunners.get("claude") ? "claude" : providerId;
    const runner = agentRunners.get(launchId);
    if (!runner) {
      sendJson(res, 400, { error: `Unknown provider: ${providerId}` });
      return;
    }

    // Resolve caller-supplied workspace IDs only through the registry so clients cannot choose arbitrary launch paths.
    const workspaceId = body.workspaceId ?? process.cwd();
    const project = projectRegistry.get(workspaceId);
    if (body.workspaceId !== undefined && project === undefined) {
      sendJson(res, 400, { error: `Unknown workspace: ${workspaceId}` });
      return;
    }
    const cwd = project?.path ?? workspaceId;
    // The family it routes on, and the name it goes by. Recorded for **every** runner this
    // host can place, not only the two native ids: a `ccs` account recorded nothing until
    // 2026-09-08, so the transcript route could not place its pane and the phone was told the
    // machine records nothing (`agent/runner-family.ts`).
    const family = runnerFamily(providerId);
    const mode = body.permissionMode;
    let configDir: SpawnConfigDir;
    try {
      configDir = launchId === "claude" ? claudeConfigDir(ccsAccount ?? body.profileId, accounts) : undefined;
    } catch (err) {
      if (!(err instanceof UnknownSpawnAccountError)) throw err;
      sendJson(res, 400, { error: err.message });
      return;
    }

    try {
      const state = await workerPool.submit(() => spawnCell(
        ptyManager,
        runner,
        {
          cwd,
          workspaceId,
          ...(family.provider === undefined ? {} : { provider: family.provider }),
          ...(family.runnerLabel === undefined ? {} : { runnerLabel: family.runnerLabel }),
          // Kept on the session, not only on the command line: the fleet reports this
          // cell's posture long after the spawn (ADR-8, `gatingFor`).
          ...(mode !== undefined ? { permissionMode: mode } : {}),
        },
        {
          cwd,
          provider: launchId,
          ...(body.initialPrompt !== undefined ? { prompt: body.initialPrompt } : {}),
          ...(mode !== undefined ? { permissionMode: mode } : {}),
          // `spawn-tuning`, forwarded and not judged: the CLI is the only thing that can
          // settle whether `opus` is an alias it knows (`cell-routes.ts`). Read off the
          // body here because this route had only ever looked at `permissionMode`, so a
          // picked model reached the machine and died one layer short of the argv.
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.effort !== undefined ? { effort: body.effort } : {}),
          ...(configDir !== undefined ? { configDir } : {}),
        },
      ));
      const response: SpawnCellResponse = {
        paneId: state.id,
        workspaceId,
        cwd,
        // Pane and session are the same object here, unlike on the desktop where a pane
        // wraps one — and the phone addresses output and interrupts by session.
        sessionId: state.id,
        provider: body.provider,
      };
      sendJson(res, 200, response);
    } catch (err) {
      if (err instanceof ProviderUnavailableError) {
        sendJson(res, 503, { error: err.message });
        return;
      }
      throw err;
    }
  };
}

/** A host without account services can run only its ambient account, so a named one is refused. */
function claudeConfigDir(named: string | undefined, accounts: Pick<AccountServices, "claudeAccounts" | "defaults"> | undefined): SpawnConfigDir {
  if (accounts === undefined) {
    if (named === undefined) return undefined;
    throw new UnknownSpawnAccountError("accounts are not configured on this host");
  }
  return spawnConfigDir(named, accounts.claudeAccounts(), accounts.defaults.get());
}

/**
 * `POST /api/fleet/close` — ends a cell. Idempotent on purpose: a pane that is already
 * gone is the state the caller wanted, and answering 404 would make the phone draw a
 * failure for a cell that is correctly absent.
 */
export function closeFleetHandler(ptyManager: PtyManager, workerPool: WorkerPool): RouteHandler {
  return async (req, res): Promise<void> => {
    let body: { paneId?: string };
    try {
      body = await readJson<{ paneId?: string }>(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    const paneId = body.paneId;
    if (!paneId) {
      sendJson(res, 400, { error: "paneId is required" });
      return;
    }
    try {
      // On a daemon-backed host this ends the daemon's session too — `PtyManager.kill` owns that
      // difference, so closing a cell does not leave a detached session behind (ADR-0067).
      ptyManager.kill(paneId);
    } catch (err) {
      if (!(err instanceof SessionNotFoundError)) throw err;
    }
    workerPool.release(paneId);
    sendJson(res, 200, { ok: true, paneId });
  };
}

function legacyCcsAccount(id: string, accounts: Pick<AccountServices, "claudeAccounts"> | undefined): string | undefined {
  const name = runnerProfileId(id);
  return name !== undefined && accounts?.claudeAccounts().some((a) => a.id === name) ? name : undefined;
}

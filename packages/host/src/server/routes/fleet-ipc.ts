import type { ServerResponse } from "node:http";
import type { RouteHandler } from "../router.js";
import type { PtyManager } from "../pty/manager.js";
import type { AgentRunnerRegistry } from "../agent/registry.js";
import type { ProjectRegistry } from "../projects/registry.js";
import type { PtySessionState } from "../pty/types.js";
import type { AgentProviderId } from "../agent/types.js";
import { SessionNotFoundError } from "../pty/errors.js";
import { ProviderUnavailableError } from "../agent/errors.js";
import { spawnCell } from "../agent/spawn-cell.js";
import type { WorkerPool } from "../fleet/worker-pool.js";
import type { FleetMember } from "../../types/fleet.js";
import type { StructuredFleetRef } from "../structured-fleet-ref.js";
import { readJson } from "./utils.js";
import { dispatchWritePlan } from "../fleet/dispatch-plan.js";

const ENSURE_FLEET_MAX_COUNT = 16;

/**
 * `/v1/*` fleet surface for the Standalone Orchestrator. Mirrors the desktop
 * `mcp_ipc.rs` response shapes so the shared MCP sidecar drives either host,
 * but sources the fleet directly from {@link PtyManager} (there is no frontend
 * snapshot to push, so `snapshot_age_ms` is always 0 — the fleet is live).
 * `surface` / `team_id` filters are accepted but inert: standalone cells carry
 * no such metadata. See ADR-0019.
 */

const PREVIEW_BYTES = 256;
const DEFAULT_TAIL = 4096;
const MAX_TAIL = 64 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
const bad = (res: ServerResponse, error: string): void => send(res, 400, { error });

interface ListBody { workspace_id?: string; verbose?: boolean }
interface SpawnBody { provider?: string; workspace_id?: string; prompt?: string }
interface DispatchBody { pane_id?: string; command?: string; append_newline?: boolean }
interface ReadBody { pane_id?: string; tail_bytes?: number }
interface CloseBody { pane_id?: string }
interface EnsureBody { provider?: string; count?: number; workspace_id?: string }

function resolveCwd(projectRegistry: ProjectRegistry, workspaceId: string): string {
  return projectRegistry.get(workspaceId)?.path ?? workspaceId;
}
const fleetProviderOf = (p: AgentProviderId): "claude" | "codex" | undefined =>
  p === "claude" || p === "codex" ? p : undefined;

function previewOf(ptyManager: PtyManager, id: string): string | undefined {
  try {
    const tail = ptyManager.getSession(id).getBufferTail(PREVIEW_BYTES).trim();
    return tail.length > 0 ? tail : undefined;
  } catch {
    return undefined;
  }
}

function compactMember(ptyManager: PtyManager, s: PtySessionState): Record<string, unknown> {
  const member: Record<string, unknown> = {
    pane_id: s.id,
    workspace_id: s.workspaceId ?? s.cwd,
    cwd: s.cwd,
    provider: s.provider ?? "claude",
    status: s.status,
    is_alive: s.status === "running",
  };
  const preview = previewOf(ptyManager, s.id);
  if (preview !== undefined) member.last_output_preview = preview;
  return member;
}

/**
 * One headless cell, in the same spelling the PTY ones use.
 *
 * `tui` is the field a caller acts on: a cell with a terminal has a byte stream to read and
 * write, and one without has no terminal to attach to at all —
 * its output is a structured protocol, not bytes. Telling them apart by guessing at the
 * `ss-` pane-id prefix would work today and break the first time that prefix moved.
 */
function compactStructured(member: FleetMember, verbose: boolean): Record<string, unknown> {
  const compact: Record<string, unknown> = {
    pane_id: member.paneId,
    workspace_id: member.workspaceId,
    cwd: member.cwd ?? member.workspaceId,
    provider: member.agentType,
    status: member.status,
    is_alive: member.isAlive,
    tui: false,
  };
  if (verbose) {
    compact.session_id = member.paneId;
    compact.display_name = member.title;
  }
  return compact;
}

export function listFleetIpcHandler(
  ptyManager: PtyManager,
  structured?: StructuredFleetRef,
): RouteHandler {
  return async (req, res) => {
    const body = await readJson<ListBody>(req).catch(() => ({} as ListBody));
    const sessions = ptyManager
      .list()
      .filter((s) => body.workspace_id === undefined || (s.workspaceId ?? s.cwd) === body.workspace_id);
    const fleet = sessions.map((s) => {
      const member = compactMember(ptyManager, s);
      // Stated rather than implied: everything `ptyManager` runs has a terminal, and a
      // caller that cannot see which kind it is has to guess.
      member.tui = true;
      if (body.verbose) {
        member.session_id = s.id;
        member.display_name = s.title ?? s.cwd;
      }
      return member;
    });
    // The same merge `GET /m/bootstrap` does, for the surface that is not the phone.
    const headless = (structured?.list(body.workspace_id) ?? [])
      .map((member) => compactStructured(member, body.verbose === true));
    send(res, 200, { fleet: [...fleet, ...headless], snapshot_age_ms: 0 });
  };
}

export function spawnCellIpcHandler(
  ptyManager: PtyManager,
  agentRunners: AgentRunnerRegistry,
  projectRegistry: ProjectRegistry,
  workerPool: WorkerPool,
): RouteHandler {
  return async (req, res) => {
    const body = await readJson<SpawnBody>(req).catch(() => null);
    if (!body) return bad(res, "Invalid JSON body");
    if (!body.provider) return bad(res, "provider is required");
    if (!body.workspace_id) return bad(res, "workspace_id is required");

    const provider = body.provider as AgentProviderId;
    const runner = agentRunners.get(provider);
    if (!runner) return bad(res, `Unknown provider: ${body.provider}`);

    const workspaceId = body.workspace_id;
    const cwd = resolveCwd(projectRegistry, workspaceId);
    const fleetProvider = fleetProviderOf(provider);
    try {
      const state = await workerPool.submit(() => spawnCell(
        ptyManager,
        runner,
        { cwd, workspaceId, ...(fleetProvider ? { provider: fleetProvider } : {}) },
        { cwd, provider, ...(body.prompt !== undefined ? { prompt: body.prompt } : {}) },
      ));
      send(res, 200, { ok: true, paneId: state.id, workspaceId, cwd });
    } catch (err) {
      if (err instanceof ProviderUnavailableError) return send(res, 503, { error: err.message });
      send(res, 500, { error: "spawn failed" });
    }
  };
}

export function dispatchCellIpcHandler(ptyManager: PtyManager): RouteHandler {
  return async (req, res) => {
    const body = await readJson<DispatchBody>(req).catch(() => null);
    if (!body) return bad(res, "Invalid JSON body");
    if (!body.pane_id || typeof body.command !== "string") {
      return bad(res, "pane_id and command are required");
    }
    // Same split as the REST twin, and for the same measured reason (`dispatchWritePlan`):
    // the Director types into the same TUIs a phone does.
    const plan = dispatchWritePlan(body.command, body.append_newline !== false);
    try {
      ptyManager.write(body.pane_id, plan.writes[0] ?? "");
      if (plan.writes[1] !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, plan.delayBeforeSubmitMs));
        ptyManager.write(body.pane_id, plan.writes[1]);
      }
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        return send(res, 200, { ok: false, error: "no live session for paneId", paneId: body.pane_id });
      }
      throw err;
    }
    send(res, 200, {
      ok: true,
      sessionId: body.pane_id,
      paneId: body.pane_id,
      bytesWritten: plan.bytes,
    });
  };
}

export function readCellIpcHandler(ptyManager: PtyManager): RouteHandler {
  return async (req, res) => {
    const body = await readJson<ReadBody>(req).catch(() => null);
    if (!body) return bad(res, "Invalid JSON body");
    if (!body.pane_id) return bad(res, "pane_id is required");
    const limit = Math.min(Math.max(body.tail_bytes ?? DEFAULT_TAIL, 1), MAX_TAIL);
    try {
      const output = ptyManager.getSession(body.pane_id).getBufferTail(limit);
      send(res, 200, {
        ok: true,
        paneId: body.pane_id,
        sessionId: body.pane_id,
        bytes: Buffer.byteLength(output, "utf8"),
        output,
      });
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        return send(res, 200, { ok: false, error: "no live session for paneId", paneId: body.pane_id, output: "", bytes: 0 });
      }
      throw err;
    }
  };
}

export function closeCellIpcHandler(ptyManager: PtyManager, workerPool: WorkerPool): RouteHandler {
  return async (req, res) => {
    const body = await readJson<CloseBody>(req).catch(() => null);
    if (!body) return bad(res, "Invalid JSON body");
    if (!body.pane_id) return bad(res, "pane_id is required");
    try {
      ptyManager.kill(body.pane_id);
    } catch (err) {
      // Already gone — closing is idempotent, so this still counts as success.
      if (!(err instanceof SessionNotFoundError)) throw err;
    }
    workerPool.release(body.pane_id);
    send(res, 200, { ok: true, paneId: body.pane_id });
  };
}

/**
 * `/v1/ensure-fleet` — reconciles the alive count of `provider` in a workspace
 * to `count`: spawns the shortfall (through the {@link WorkerPool} cap) or
 * closes the excess oldest-first. `wait_ready` is NOT yet honoured here — the
 * Director should `wait-cell-idle` on the returned `spawned` panes.
 */
export function ensureFleetIpcHandler(
  ptyManager: PtyManager,
  agentRunners: AgentRunnerRegistry,
  projectRegistry: ProjectRegistry,
  workerPool: WorkerPool,
): RouteHandler {
  return async (req, res) => {
    const body = await readJson<EnsureBody>(req).catch(() => null);
    if (!body) return bad(res, "Invalid JSON body");
    if (!body.provider) return bad(res, "provider is required");
    if (typeof body.count !== "number" || body.count < 0) return bad(res, "count must be a non-negative number");
    if (body.count > ENSURE_FLEET_MAX_COUNT) return bad(res, `count exceeds max ${ENSURE_FLEET_MAX_COUNT}`);

    const provider = body.provider as AgentProviderId;
    const providerLc = body.provider.toLowerCase();
    const matching = ptyManager.list().filter((s) =>
      s.status === "running"
      && (s.provider ?? "claude").toLowerCase() === providerLc
      && (body.workspace_id === undefined || (s.workspaceId ?? s.cwd) === body.workspace_id));
    const aliveBefore = matching.length;

    const spawned: string[] = [];
    const closed: string[] = [];

    if (body.count > aliveBefore) {
      const runner = agentRunners.get(provider);
      if (!runner) return bad(res, `Unknown provider: ${body.provider}`);
      if (!body.workspace_id) return bad(res, "workspace_id is required to spawn");
      const workspaceId = body.workspace_id;
      const cwd = resolveCwd(projectRegistry, workspaceId);
      const fleetProvider = fleetProviderOf(provider);
      for (let i = 0; i < body.count - aliveBefore; i += 1) {
        try {
          const state = await workerPool.submit(() => spawnCell(
            ptyManager,
            runner,
            { cwd, workspaceId, ...(fleetProvider ? { provider: fleetProvider } : {}) },
            { cwd, provider },
          ));
          spawned.push(state.id);
        } catch (err) {
          if (err instanceof ProviderUnavailableError) return send(res, 503, { error: err.message });
          return send(res, 500, { error: "spawn failed" });
        }
      }
    } else if (body.count < aliveBefore) {
      for (const victim of matching.slice(0, aliveBefore - body.count)) {
        try { ptyManager.kill(victim.id); } catch { /* already gone */ }
        workerPool.release(victim.id);
        closed.push(victim.id);
      }
    }

    send(res, 200, { ok: true, aliveBefore, aliveAfter: aliveBefore + spawned.length - closed.length, spawned, closed });
  };
}

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPtyRuntime } from "./pty/runtime.js";
import { AgentRunnerRegistry } from "./agent/registry.js";
import { resolveRemoteSkillMount } from "./agent/remote-skills.js";
import { seedRemoteSkills } from "./agent/seed-remote-skills.js";
import { ProjectRegistry } from "./projects/registry.js";
import { resolveStateDir } from "../core/state-dir.js";
import { ProjectCloner } from "./projects/clone.js";
import { BrowseRoots } from "./projects/browse.js";
import { ExtraProjects } from "./projects/extra-store.js";
import { ProjectRegistrar } from "./projects/registrar.js";
import { realGit } from "../core/git.js";
import { ghAuthStatus } from "../core/gh.js";
import { NotificationBus } from "./notifications/bus.js";
import { SwarmTaskStore } from "./tasks/store.js";
import { writeMcpIpcDiscovery, removeMcpIpcDiscovery } from "./mcp-ipc-discovery.js";
import { ClaudeDirectorRunner, CodexDirectorRunner } from "./director/director-runner.js";
import { DirectorSupervisor, FileDirectorSessionStore } from "./director/supervisor.js";
import { buildLotusMcpConfig } from "./director/mcp-config.js";
import { HEADLESS_DIRECTOR_PROMPT } from "./director/prompt.js";
import { createApp } from "./app.js";
import { CHAT_ATTACHMENTS_DIR, ChatAttachmentStore } from "../core/chat-attachments.js";
import { createAccountServices, processAccountPaths } from "../core/accounts/index.js";
import { HookTurns } from "../adapters/mobile/hooks/turns.js";
import { DropWatcher, defaultDropDir } from "../adapters/mobile/hooks/watcher.js";
import { installClaudeHook } from "../adapters/mobile/hooks/install.js";
import { StructuredFleetRef } from "./structured-fleet-ref.js";

export interface StandaloneHostHandle {
  /** Whether the Claude hook is installed — what lets `hostCaps` promise TUI permission. */
  hooksInstalled: boolean;
  /**
   * Whether there is a workspace root to clone into. The same discipline as
   * [hooksInstalled]: the façade advertises `projects-create` only where this is true.
   */
  canCloneProjects: boolean;
  /** Whether it opens any directory for browsing, and will take one as a project. */
  canBrowseProjects: boolean;
  /** Base URL, e.g. "http://127.0.0.1:47823" */
  url: string;
  /** Bearer token — pass directly to ApiClient so no file is written to disk. */
  apiKey: string;
  /** Gracefully close the server and all PTY sessions. */
  stop(): Promise<void>;
  /**
   * Where the adapter installs its headless cells, once it exists.
   *
   * Handed back rather than taken in because of the boot order — see [[StructuredFleetRef]].
   * Leaving it unbound is a valid state: a host whose adapter runs no structured sessions
   * simply has none to report.
   */
  structuredFleet: StructuredFleetRef;
}

export async function createStandaloneHost(): Promise<StandaloneHostHandle> {
  const apiKey = randomBytes(32).toString("hex");

  // Which PTY backend this host runs on follows the mode: a standalone host on a VPS keeps its
  // sessions in lotus-sessiond so they survive a restart; a client-mode embed keeps node-pty.
  const ptyRuntime = await createPtyRuntime({
    mode: process.env["LOTUS_MODE"] === "standalone" ? "standalone" : "client",
    env: { LOTUS_PTY: process.env["LOTUS_PTY"] },
    logDir: join(homedir(), ".lotus", "sessions"),
    sessiondDir: join(homedir(), ".lotus", "host-sessiond"),
    ...(process.env["LOTUS_SESSIOND_BIN"] ? { sessiondBin: process.env["LOTUS_SESSIOND_BIN"] } : {}),
  });
  const ptyManager = ptyRuntime.manager;
  const agentRunners = AgentRunnerRegistry.build(ptyManager);
  const notificationBus = new NotificationBus();
  // Default the workspace root to ~/lotus-workspaces when nothing is configured,
  // so agent-cloned repos land somewhere the registry already watches (Slice 6).
  const workspaceRoot = process.env.PROJECTS_ROOT
    ?? (process.env.PROJECTS_JSON ? undefined : join(homedir(), "lotus-workspaces"));
  if (workspaceRoot) mkdirSync(workspaceRoot, { recursive: true });
  // Projects the operator picked from the phone, which by definition the scan cannot see
  // (ADR-D). Beside the rest of this host's state, so a dev profile keeps its own list.
  const extraProjects = join(resolveStateDir(process.env, homedir()), "projects.json");
  const projectRegistry = ProjectRegistry.fromConfig({
    extraProjects,
    ...(process.env.PROJECTS_JSON ? { projectsJson: process.env.PROJECTS_JSON } : {}),
    ...(workspaceRoot ? { projectsRoot: workspaceRoot } : {}),
  });
  // Clones land in the same root the registry scans, so a repo that arrives is a project
  // with no restart and no second registry (`plans/pocket-vps-project-checkout` ADR-C).
  // Absent when this host runs on a fixed `PROJECTS_JSON` list — there is nowhere to put one.
  const projectCloner = workspaceRoot
    ? new ProjectCloner({ git: realGit, root: workspaceRoot, ghAuth: ghAuthStatus })
    : undefined;
  // Where a phone may look, and nowhere else (ADR-A). The workspace root is always open —
  // it is already the place projects come from — and `LOTUS_BROWSE_ROOTS` adds the operator's
  // own, `PATH`-style. A host that names none still browses its workspace root.
  const browseRoots = new BrowseRoots(
    [
      ...(workspaceRoot ? [workspaceRoot] : []),
      ...(process.env.LOTUS_BROWSE_ROOTS ?? "").split(":").map((p) => p.trim()).filter(Boolean),
    ],
    {
      // Read fresh on every listing, so a project taken a moment ago is already marked.
      held: () => projectRegistry.list().map((p) => p.path),
      ...(workspaceRoot ? { scanRoot: workspaceRoot } : {}),
    },
  );
  // Built beside the registry rather than shared with it: both point at the same file and
  // neither caches, so a second instance cannot hold a stale list — and the read model stays
  // a read model instead of growing writes.
  const projectRegistrar = new ProjectRegistrar({
    extra: new ExtraProjects(extraProjects),
    registry: projectRegistry,
    browse: browseRoots,
    ...(workspaceRoot ? { scanRoot: workspaceRoot } : {}),
  });
  const taskStore = new SwarmTaskStore({
    baseDir: process.env.TASKS_DIR ?? join(homedir(), ".lotus", "standalone-tasks"),
  });

  // Seed bundled integration skills (github/aws/stripe) into the Remote-Scoped
  // Skills mount so the agent auto-discovers them via --add-dir (ADR-0018).
  // Non-destructive — operator-edited skills are preserved.
  const skillSeedDir = process.env.LOTUS_SKILLS_SEED_DIR
    ?? fileURLToPath(new URL("../../skills", import.meta.url));
  seedRemoteSkills(skillSeedDir, resolveRemoteSkillMount());

  // Headless Director — the standalone host's orchestrator brain (ADR-0019/0020).
  // Enabled by default (this host IS the orchestrator); set DIRECTOR_PROVIDER=off
  // to run as a plain remote-control host. Only claude is wired today (Slice 7).
  const discoveryPath = process.env.MCP_IPC_DISCOVERY_PATH
    ?? join(homedir(), ".lotus", "lotus-mcp-ipc.json");
  const director = buildDirector(discoveryPath, workspaceRoot ?? process.cwd(), notificationBus);

  // Hooks: install the script, watch the drop dir, and hand both producers one map. Failure is
  // never fatal — `hostCaps` reports what this host can actually do, and a permission it cannot
  // observe is one it must not advertise.
  const hookTurns = new HookTurns();
  const hooks = installClaudeHook({ stateDir: join(homedir(), ".lotus"), discoveryPath });
  const dropWatcher = new DropWatcher({
    dir: defaultDropDir(),
    onPayload: (payload) => { hookTurns.record(payload); },
  });
  dropWatcher.start();

  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  // Created here, bound later: the adapter that owns the structured sessions does not exist
  // until `index.ts` builds it, and it reaches this server as an HTTP client.
  const structuredFleet = new StructuredFleetRef();

  const attachments = new ChatAttachmentStore(join(resolveStateDir(process.env, homedir()), CHAT_ATTACHMENTS_DIR));
  attachments.sweep();
  const attachmentSweep = setInterval(() => attachments.sweep(), 3600_000);
  attachmentSweep.unref();

  const handler = createApp({
    attachments,
    ptyManager, agentRunners, projectRegistry, notificationBus, taskStore, apiKey, port, hookTurns,
    structuredFleet,
    accounts: { machine: hostname(), ...createAccountServices(processAccountPaths()) },
    ...(projectCloner ? { projectCloner } : {}),
    ...(browseRoots.roots().length > 0 ? { browseRoots, projectRegistrar } : {}),
    ...(director ? { director } : {}),
  });
  server.on("request", handler);

  // Advertise the /v1/* surface so the MCP sidecar (and thus the Headless
  // Director) can reach this host via `--discovery` (ADR-0019).
  writeMcpIpcDiscovery(discoveryPath, { port, secret: apiKey });

  const stop = async (): Promise<void> => {
    clearInterval(attachmentSweep);
    dropWatcher.stop();
    removeMcpIpcDiscovery(discoveryPath);
    ptyRuntime.stop();
    ptyManager.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return {
    url,
    apiKey,
    stop,
    structuredFleet,
    hooksInstalled: hooks !== undefined,
    canCloneProjects: projectCloner !== undefined,
    canBrowseProjects: browseRoots.roots().length > 0,
  };
}

/**
 * Wires the Headless Director (claude runtime) against the vendored MCP sidecar,
 * or returns undefined when `DIRECTOR_PROVIDER=off` / an unsupported provider.
 * The session id persists in `~/.lotus/director-session.json` so the Director
 * resumes its conversation across host restarts.
 */
function buildDirector(
  discoveryPath: string,
  cwd: string,
  notificationBus: NotificationBus,
): DirectorSupervisor | undefined {
  const provider = process.env.DIRECTOR_PROVIDER ?? "claude";
  if (provider !== "claude" && provider !== "codex") return undefined; // "off" / unsupported

  const mcp = {
    sidecarCommand: process.env.LOTUS_MCP_SIDECAR_CMD ?? "bun",
    sidecarPath: process.env.LOTUS_MCP_SIDECAR_PATH
      ?? fileURLToPath(new URL("../../mcp/lotus-mcp-server.mjs", import.meta.url)),
    discoveryPath,
  };
  const runner = provider === "codex"
    ? new CodexDirectorRunner(HEADLESS_DIRECTOR_PROMPT, mcp)
    : new ClaudeDirectorRunner(buildLotusMcpConfig(mcp), HEADLESS_DIRECTOR_PROMPT);
  // Scope the persisted session id per provider — a claude session id is not a
  // valid codex thread id (and vice-versa), so they must never cross-resume.
  const sessionStore = new FileDirectorSessionStore(join(homedir(), ".lotus", `director-session-${provider}.json`));
  return new DirectorSupervisor({
    runner,
    cwd,
    sessionStore,
    newSessionId: () => randomUUID(),
    // Deliver the Director's reply asynchronously via the notification stream;
    // the remote adapter relays it to the chat (the goal route is fire-and-forget).
    onReply: (result) => notificationBus.publish({
      kind: "director_reply",
      text: result.text,
      session_id: result.sessionId,
      is_error: result.isError,
      timestamp: Date.now(),
    }),
  });
}

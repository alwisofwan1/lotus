import { readFileSync, watch } from "node:fs";
import type { RequestListener } from "node:http";
import type { PtyManager } from "./pty/manager.js";
import type { AgentRunnerRegistry } from "./agent/registry.js";
import type { ProjectRegistry } from "./projects/registry.js";
import type { ProjectCloner } from "./projects/clone.js";
import type { BrowseRoots } from "./projects/browse.js";
import type { ProjectRegistrar } from "./projects/registrar.js";
import type { NotificationBus } from "./notifications/bus.js";
import { Router } from "./router.js";
import { checkBearer } from "./auth.js";
import { healthHandler } from "./routes/health.js";
import {
  listSessionsHandler,
  createSessionHandler,
  writeSessionHandler,
  resizeSessionHandler,
  killSessionHandler,
  streamSessionHandler,
} from "./routes/sessions.js";
import {
  addProjectHandler, browseHandler, cloneProjectHandler, cloneStatusHandler,
  forgetProjectHandler, listProjectsHandler,
} from "./routes/projects.js";
import { bridgeChatHandler } from "./routes/bridge.js";
import { listProcessesHandler, spawnPtyHandler } from "./routes/agent.js";
import { notificationStreamHandler } from "./routes/notifications.js";
import { listFleetHandler, readCellHandler, readScrollbackHandler, dispatchCellHandler } from "./routes/fleet.js";
import { spawnFleetHandler, closeFleetHandler } from "./routes/fleet-lifecycle.js";
import { cellPermissionHandler, hookTurnHandler } from "./routes/hooks.js";
import { HookTurns } from "../adapters/mobile/hooks/turns.js";
import { CliSources } from "../adapters/mobile/hooks/sources.js";
import { cellTranscriptHandler } from "./routes/transcript.js";
import { TranscriptEmitter } from "../adapters/mobile/transcript/emitter.js";
import { TranscriptWatcher } from "../adapters/mobile/transcript/watcher.js";
import { claudeSessionHeadline, readClaudeTranscript } from "../adapters/mobile/transcript/claude-transcript.js";
import { listRunnersHandler } from "./routes/runners.js";
import { listWorkspacesHandler } from "./routes/workspaces.js";
import {
  createTaskHandler,
  updateTaskHandler,
  appendTaskFeedbackEventHandler,
  listTasksHandler,
  getTaskHandler,
} from "./routes/tasks-ipc.js";
import {
  listFleetIpcHandler,
  spawnCellIpcHandler,
  dispatchCellIpcHandler,
  readCellIpcHandler,
  closeCellIpcHandler,
  ensureFleetIpcHandler,
} from "./routes/fleet-ipc.js";
import { waitCellIdleHandler } from "./routes/wait-cell-idle.js";
import { submitGoalHandler } from "./routes/director.js";
import { WorkerPool } from "./fleet/worker-pool.js";
import type { SwarmTaskStore } from "./tasks/store.js";
import type { DirectorSupervisor } from "./director/supervisor.js";
import type { StructuredFleetRef } from "./structured-fleet-ref.js";
import {
  createAccountHandler,
  listAccountsHandler,
  migrateCcsHandler,
  removeAccountHandler,
  setDefaultAccountHandler,
  usageHandler,
  type AccountRoutesDeps,
} from "./routes/usage.js";
import { chatCellHandler } from "./routes/chat-cell.js";
import { chatAttachmentDropHandler, chatAttachmentUploadHandler } from "./routes/chat-attachments.js";
import type { ChatAttachmentStore } from "../core/chat-attachments.js";
import { structuredConversationStreamHandler } from "./routes/structured-conversation-stream.js";
import { structuredConversationHandler } from "./routes/structured-conversation.js";

const DEFAULT_MAX_WORKERS = 4;

export interface AppDeps {
  ptyManager: PtyManager;
  agentRunners: AgentRunnerRegistry;
  projectRegistry: ProjectRegistry;
  /** Absent on a host with no workspace root — clone routes then answer 503. */
  projectCloner?: ProjectCloner;
  /** The directories this host opens for browsing. Absent means it opens none. */
  browseRoots?: BrowseRoots;
  /** Takes a folder already on the machine. Absent means this host only clones. */
  projectRegistrar?: ProjectRegistrar;
  notificationBus: NotificationBus;
  taskStore: SwarmTaskStore;
  apiKey: string;
  port: number;
  /** Max concurrently-alive worker cells before spawns queue (default 4). */
  maxWorkers?: number;
  /** Headless Director, if enabled on this host (standalone orchestrator). */
  director?: DirectorSupervisor;
  /** Copies of Chat Attachments sent from another machine. Absent: the routes are not mounted. */
  attachments?: ChatAttachmentStore;
  /** Shared so the drop-file watcher writes where the permission read looks. */
  hookTurns?: HookTurns;
  /** Where each pane's CLI keeps its own transcript, as the CLI reported it (slice 3.1). */
  cliSources?: CliSources;
  /**
   * The cells the mobile adapter runs itself, so `/v1/list-fleet` answers what
   * `/m/bootstrap` already does. Late-bound — see [[StructuredFleetRef]] for why it cannot
   * be a plain value here.
   */
  structuredFleet?: StructuredFleetRef;
  /** This machine's accounts and usage; absent means `/v1/usage` answers 503. */
  accounts?: AccountRoutesDeps;
}

/**
 * How much of a pane's tail the permission read parses.
 *
 * Enough to hold a prompt and the question above it, not so much that a long scrollback makes
 * `parsePermissionPrompt` walk pages of history — it searches from the end for the LAST option
 * run, so extra bytes buy nothing and cost time on every poll.
 */
const PERMISSION_TAIL_BYTES = 8 * 1024;

export function createApp(deps: AppDeps): RequestListener {
  const router = new Router();
  // One map, two producers: the shell hook posts to `/v1/hook/turn`, and the drop-file watcher
  // (`adapters/mobile/hooks/watcher.ts`) records the richer payloads into the same place.
  const hookTurns = deps.hookTurns ?? new HookTurns();
  const cliSources = deps.cliSources ?? new CliSources();
  const workerPool = new WorkerPool(
    deps.maxWorkers ?? DEFAULT_MAX_WORKERS,
    () => new Set(deps.ptyManager.list().map((s) => s.id)),
  );

  router.add("GET", "/health", healthHandler(deps.port));
  router.add("GET", "/api/sessions", listSessionsHandler(deps.ptyManager));
  router.add("POST", "/api/sessions", createSessionHandler(deps.ptyManager));
  router.add("POST", "/api/sessions/:id/input", writeSessionHandler(deps.ptyManager));
  router.add("POST", "/api/sessions/:id/resize", resizeSessionHandler(deps.ptyManager));
  router.add("DELETE", "/api/sessions/:id", killSessionHandler(deps.ptyManager));
  router.add("GET", "/api/sessions/:id/stream", streamSessionHandler(deps.ptyManager));
  router.add("GET", "/api/projects", listProjectsHandler(deps.projectRegistry));
  router.add("POST", "/api/projects/clone", cloneProjectHandler(deps.projectCloner));
  router.add("GET", "/api/projects/clone/:taskId", cloneStatusHandler(deps.projectCloner));
  router.add("GET", "/api/fs", browseHandler(deps.browseRoots));
  router.add("POST", "/api/projects", addProjectHandler(deps.projectRegistrar));
  router.add("DELETE", "/api/projects/:id", forgetProjectHandler(deps.projectRegistrar));
  // Read out of the same file read, so the fleet's line under a cell name costs no IO of its
  // own: a fleet poll every three seconds re-reading every transcript would be the expensive
  // way to learn something that only changes when the agent speaks.
  const headlines = new Map<string, string>();
  router.add("GET", "/api/fleet", listFleetHandler(
    deps.ptyManager,
    (paneId) => headlines.get(paneId),
    // This host records its own hooks, so it can answer what a cell is doing rather than
    // leaving the phone to draw "state unknown" over a pane it hears from every turn.
    (paneId) => hookTurns.statusOf(paneId),
  ));
  router.add("POST", "/api/fleet/read", readCellHandler(deps.ptyManager));
  router.add("POST", "/api/fleet/scrollback", readScrollbackHandler(deps.ptyManager));
  router.add("POST", "/api/fleet/dispatch", dispatchCellHandler(deps.ptyManager));
  // The two `ApiClient` has always called and standalone never served (`issues/03`).
  router.add("POST", "/api/fleet/spawn", spawnFleetHandler(deps.ptyManager, deps.agentRunners, deps.projectRegistry, workerPool, deps.accounts));
  router.add("POST", "/api/fleet/close", closeFleetHandler(deps.ptyManager, workerPool));
  // The two halves of ADR-8's rule, against one turn map: hooks write, the permission read joins
  // what they said to what the terminal shows (slice 1b).
  // What makes Chat move on its own. A phone appends from `notification` frames carrying a hook
  // payload, and until slice 3.6 a standalone host published none: it recorded every turn and
  // said nothing, so Chat read correctly and never updated until a pull-to-refresh.
  const transcriptEmitter = new TranscriptEmitter({
    entriesOf: (paneId) => {
      const source = cliSources.sourceOf(paneId);
      if (source === undefined) return [];
      const read = readTranscriptFile(source.transcriptPath);
      if (!read.ok) return [];
      const headline = claudeSessionHeadline(read.text);
      if (headline !== undefined) headlines.set(paneId, headline);
      return readClaudeTranscript(read.text);
    },
    cwdOf: (paneId) => {
      try {
        return deps.ptyManager.getSession(paneId).cwd;
      } catch {
        return undefined;
      }
    },
    publish: (event) => { deps.notificationBus.publish(event); },
  });
  // A hook fire says a pane is worth reading; the file says when there is something to read. The
  // CLI fires `Stop` *before* the reply is on disk, so a hook-only read published it 60s late —
  // on the next unrelated hook (`transcript/watcher.ts`).
  const transcriptWatcher = new TranscriptWatcher({
    watch: (path, onChange) => {
      const handle = watch(path, () => onChange());
      // A watch that errors — the file rotated, the volume went away — is released rather than
      // left throwing on an unhandled event: the next hook fire follows the new path.
      handle.on("error", () => handle.close());
      return { close: () => handle.close() };
    },
    isLive: (paneId) => providerOf(paneId) !== undefined,
    onChanged: (paneId) => { transcriptEmitter.onTurn(paneId, "claude"); },
  });
  router.add("POST", "/v1/hook/turn", hookTurnHandler(hookTurns, cliSources, (paneId) => {
    // Only a runner whose format this host reads. Anything else has no entries to publish, and
    // an empty read must not look like a cell that went quiet.
    if (providerOf(paneId) !== "claude") return;
    transcriptEmitter.onTurn(paneId, "claude");
    const source = cliSources.sourceOf(paneId);
    if (source !== undefined) transcriptWatcher.follow(paneId, source.transcriptPath);
  }));
  // The Chat page for a TUI cell, from the runner's own transcript file. The mobile façade's
  // `ApiClient` points at this host in standalone mode and asks for exactly this path, so a route
  // here is what turns `hostSupports: false` into a conversation (slice 3.3).
  const providerOf = (paneId: string): string | undefined => {
    try {
      return deps.ptyManager.getSession(paneId).state.provider;
    } catch {
      return undefined; // not a pane this host runs
    }
  };
  const readTranscriptFile = (path: string): { ok: true; text: string } | { ok: false; missing: boolean } => {
    try {
      return { ok: true, text: readFileSync(path, "utf8") };
    } catch (err) {
      // ENOENT is not a fault: claude reports the path from its first hook and writes the file
      // only when it has something to write (slice 3.3).
      return { ok: false, missing: (err as NodeJS.ErrnoException).code === "ENOENT" };
    }
  };
  router.add("GET", "/api/fleet/:paneId/transcript", cellTranscriptHandler({
    sources: cliSources,
    providerOf,
    readFile: readTranscriptFile,
  }));
  router.add("GET", "/api/fleet/:paneId/permission", cellPermissionHandler(hookTurns, {
    screenOf: async (paneId) => {
      try {
        const session = deps.ptyManager.getSession(paneId);
        // The rendered screen, never the raw buffer: stripping escapes off a TUI's stream
        // destroys the layout the digits are read from (`issues/17`). A backend with no terminal
        // behind it reports nothing to see rather than a mangled something.
        return { text: (await session.renderScreen()) ?? "", columns: session.state.cols };
      } catch {
        return undefined; // no live session — the route answers `hostSupports: false`
      }
    },
  }));
  router.add("GET", "/api/workspaces", listWorkspacesHandler(deps.ptyManager, deps.projectRegistry));
  router.add("GET", "/api/runners", listRunnersHandler(deps.agentRunners));
  router.add("POST", "/api/bridge/chat", bridgeChatHandler(deps.agentRunners, deps.projectRegistry));
  router.add("GET", "/api/agent/processes", listProcessesHandler());
  router.add(
    "POST",
    "/api/agent/spawn-pty",
    spawnPtyHandler(deps.ptyManager, deps.agentRunners, deps.projectRegistry),
  );
  router.add("GET", "/api/notifications/stream", notificationStreamHandler(deps.notificationBus));

  // /v1/* — MCP-IPC surface consumed by the Headless Director's sidecar (ADR-0019).
  router.add("POST", "/v1/list-fleet", listFleetIpcHandler(deps.ptyManager, deps.structuredFleet));
  router.add("POST", "/v1/usage", usageHandler(deps.accounts));
  router.add("POST", "/v1/accounts/default", setDefaultAccountHandler(deps.accounts));
  router.add("POST", "/v1/accounts/list", listAccountsHandler(deps.accounts));
  router.add("POST", "/v1/accounts/create", createAccountHandler(deps.accounts));
  router.add("POST", "/v1/accounts/remove", removeAccountHandler(deps.accounts));
  router.add("POST", "/v1/accounts/migrate-ccs", migrateCcsHandler(deps.accounts));
  router.add("POST", "/v1/cell-conversation", structuredConversationHandler(deps.structuredFleet));
  router.add("GET", "/v1/cell-conversation/stream", structuredConversationStreamHandler(deps.structuredFleet));
  router.add("POST", "/v1/chat-cell/:action", chatCellHandler(deps.structuredFleet));
  if (deps.attachments) {
    router.add("POST", "/v1/chat-attachments", chatAttachmentUploadHandler(deps.attachments));
    router.add("POST", "/v1/chat-attachments/drop", chatAttachmentDropHandler(deps.attachments));
  }
  router.add("POST", "/v1/spawn-cell", spawnCellIpcHandler(deps.ptyManager, deps.agentRunners, deps.projectRegistry, workerPool));
  router.add("POST", "/v1/dispatch-to-cell", dispatchCellIpcHandler(deps.ptyManager));
  router.add("POST", "/v1/read-cell-output", readCellIpcHandler(deps.ptyManager));
  router.add("POST", "/v1/close-cell", closeCellIpcHandler(deps.ptyManager, workerPool));
  router.add("POST", "/v1/ensure-fleet", ensureFleetIpcHandler(deps.ptyManager, deps.agentRunners, deps.projectRegistry, workerPool));
  router.add("POST", "/v1/wait-cell-idle", waitCellIdleHandler(deps.ptyManager));
  router.add("POST", "/api/director/goal", submitGoalHandler(deps.director));
  router.add("POST", "/v1/tasks/create", createTaskHandler(deps.taskStore));
  router.add("POST", "/v1/tasks/update", updateTaskHandler(deps.taskStore));
  router.add("POST", "/v1/tasks/append-feedback-event", appendTaskFeedbackEventHandler(deps.taskStore));
  router.add("POST", "/v1/tasks/list", listTasksHandler(deps.taskStore));
  router.add("POST", "/v1/tasks/get", getTaskHandler(deps.taskStore));

  return (req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/api/") || url.startsWith("/v1/")) {
      const auth = req.headers["authorization"];
      if (!checkBearer(auth, deps.apiKey)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    if (!router.dispatch(req, res)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not Found" }));
    }
  };
}

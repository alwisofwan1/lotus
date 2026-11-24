import type {
  BridgeChatRequest,
  BridgeChatResponse,
  BridgeTask,
  CreateSessionRequest,
  CreateTaskRequest,
  CreatedSession,
  HealthResponse,
  CloneProjectRequest,
  LaunchConfig,
  LaunchPtyResult,
  LaunchResult,
  DispatchRequest,
  DispatchResponse,
  ListFleetQuery,
  ListRunnersResponse,
  ListFleetResponse,
  ListTasksQuery,
  ListTasksResponse,
  ListWorkspacesResponse,
  ProcessInfo,
  ReadCellRequest,
  ReadCellResponse,
  ScrollbackRequest,
  ScrollbackResponse,
  TranscribeRequest,
  TranscribeResult,
  PermissionResponse,
  TranscriptResponse,
  SessionInfo,
  SpawnCellRequest,
  SpawnCellResponse,
  UpdateTaskRequest,
} from "../types/index.js";
import { postBridgeChat } from "./api-client-bridge-chat.js";
import * as cells from "./api-client-cells.js";
import * as director from "./api-client-director.js";
import * as projects from "./api-client-projects.js";
import { buildQueryString } from "./api-client-util.js";
import { ApiError } from "./api-error.js";
import {
  openNotificationStream,
  openSseStream,
  type NotificationStream,
  type SseStream,
} from "./api-sse.js";

export { ApiError } from "./api-error.js";
export { decodeSseLine } from "./api-sse.js";
export type { NotificationStream, SseStream } from "./api-sse.js";

/**
 * Typed HTTP client for the Lotus embedded API server.
 * All methods throw `ApiError` on non-2xx responses.
 */
export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  // ─── Internal helpers ──────────────────────────────────────────────────────

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  /** `request`, bound once so the cell-lifecycle functions can be handed it. */
  private readonly boundRequest: cells.CellRequest = (method, path, body) =>
    this.request(method, path, body);

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = {
      method,
      headers: this.authHeaders(),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const resp = await fetch(`${this.baseUrl}${path}`, init);

    if (!resp.ok) {
      let message = resp.statusText;
      try {
        const err = (await resp.json()) as { error?: string };
        if (err.error) message = err.error;
      } catch {
        // ignore JSON parse failure
      }
      throw new ApiError(resp.status, message);
    }

    if (resp.status === 204) return undefined as T;
    return resp.json() as Promise<T>;
  }

  // ─── Health ────────────────────────────────────────────────────────────────

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health");
  }

  // ─── PTY sessions ──────────────────────────────────────────────────────────

  listSessions(): Promise<SessionInfo[]> {
    return this.request<SessionInfo[]>("GET", "/api/sessions");
  }

  createSession(req: CreateSessionRequest = {}): Promise<CreatedSession> {
    return this.request<CreatedSession>("POST", "/api/sessions", req);
  }

  killSession(id: string): Promise<void> {
    return this.request<void>("DELETE", `/api/sessions/${id}`);
  }

  writeToSession(id: string, data: string): Promise<void> {
    return this.request<void>("POST", `/api/sessions/${id}/input`, { data });
  }

  /** Opens a native fetch-based SSE stream for the given session. */
  streamSession(sessionId: string): SseStream {
    return openSseStream(
      `${this.baseUrl}/api/sessions/${sessionId}/stream`,
      this.authHeaders({ Accept: "text/event-stream" }),
    );
  }

  /** Opens a native fetch-based SSE stream for the notification channel. */
  streamNotifications(): NotificationStream {
    return openNotificationStream(
      `${this.baseUrl}/api/notifications/stream`,
      this.authHeaders({ Accept: "text/event-stream" }),
    );
  }

  // ─── Agent / process management ───────────────────────────────────────────

  spawnAgent(config: LaunchConfig): Promise<LaunchResult> {
    return this.request<LaunchResult>("POST", "/api/agent/spawn", config);
  }

  /** Spawns the team in an interactive PTY and returns the id to attach to. */
  spawnAgentPty(config: LaunchConfig): Promise<LaunchPtyResult> {
    // Remote-adapter origin → Remote Session Scope by default (ADR-0018).
    return this.request<LaunchPtyResult>("POST", "/api/agent/spawn-pty", { remoteScoped: true, ...config });
  }

  listProcesses(): Promise<ProcessInfo[]> {
    return this.request<ProcessInfo[]>("GET", "/api/agent/processes");
  }

  killProcess(pid: number): Promise<void> {
    return this.request<void>("DELETE", `/api/agent/processes/${pid}`);
  }

  // ─── Fleet (Bridge MCP) ────────────────────────────────────────────────────

  /** Fleet members the desktop can see. Defaults to page 1, pageSize 10 (max 100). */
  listFleet(query: ListFleetQuery = {}): Promise<ListFleetResponse> {
    const qs = buildQueryString({
      workspaceId: query.workspaceId,
      page: query.page,
      pageSize: query.pageSize,
    });
    return this.request<ListFleetResponse>("GET", `/api/fleet${qs}`);
  }

  /** Up to `tailBytes` of a cell's output (server clamps to 64 KB). 404 if unknown. */
  readCellOutput(req: ReadCellRequest): Promise<ReadCellResponse> {
    return this.request<ReadCellResponse>("POST", "/api/fleet/read", req);
  }

  /**
   * A cell's hook-event history — what Chat renders on open. An empty list for a pane
   * that recorded nothing, so a `codex` cell emitting no hooks is not an error.
   */
  /** `before`/`limit` page backwards through the runner's own transcript (Fase 3). */
  readCellTranscript(paneId: string, page: cells.TranscriptPage = {}): Promise<TranscriptResponse> {
    return this.request<TranscriptResponse>("GET", cells.transcriptPath(paneId, page));
  }

  /**
   * What a cell is asking and which answers it offers. `prompt: null` unless the hook
   * says it is waiting AND the options were readable — never a guessed digit.
   */
  readCellPermission(paneId: string): Promise<PermissionResponse> {
    return this.request<PermissionResponse>(
      "GET",
      `/api/fleet/${encodeURIComponent(paneId)}/permission`,
    );
  }

  /**
   * Output from an absolute byte offset — the only form that can resume.
   *
   * `readCellOutput` answers "the last N bytes", which cannot express "what I missed
   * while the phone was away". The response says where the text actually starts, so a
   * ring buffer that moved on is visible rather than silently skipped.
   */
  readScrollback(req: ScrollbackRequest): Promise<ScrollbackResponse> {
    return this.request<ScrollbackResponse>("POST", "/api/fleet/scrollback", req);
  }

  /**
   * Transcribes with whichever STT provider the desktop has active. 503 means it is
   * configured to transcribe on the device — a fork, not a fault (ADR-11).
   */
  transcribeAudio(req: TranscribeRequest): Promise<TranscribeResult> {
    return this.request<TranscribeResult>("POST", "/api/stt/transcribe", req);
  }

  /**
   * Lists workspaces grouped from the current fleet snapshot, sorted
   * alphabetically by workspaceId. Returns an empty list when no cells are
   * running.
   */
  listWorkspaces(): Promise<ListWorkspacesResponse> {
    return this.request<ListWorkspacesResponse>("GET", "/api/workspaces");
  }

  // A cell's lifecycle lives in `api-client-cells.ts`; these forward to it.
  dispatchToCell(req: DispatchRequest): Promise<DispatchResponse> {
    return cells.dispatchToCell(this.boundRequest, req);
  }

  spawnCell(req: SpawnCellRequest): Promise<SpawnCellResponse> {
    return cells.spawnCell(this.boundRequest, req);
  }

  closeCell(paneId: string): Promise<void> {
    return cells.closeCell(this.boundRequest, paneId);
  }

  holdSessionSize = (id: string, size: { cols: number; rows: number; token?: number }) =>
    cells.holdSessionSize(this.boundRequest, id, size);
  releaseSessionSize = (id: string, token: number) => cells.releaseSessionSize(this.boundRequest, id, token);

  listRunners(): Promise<ListRunnersResponse> {
    return cells.listRunners(this.boundRequest);
  }

  // ─── Tasks (bridge_tasks CRUD) ────────────────────────────────────────────

  listTasks(query: ListTasksQuery): Promise<ListTasksResponse> {
    const qs = buildQueryString({
      workspaceId: query.workspaceId,
      status: query.status,
      page: query.page,
      pageSize: query.pageSize,
    });
    return this.request<ListTasksResponse>("GET", `/api/tasks${qs}`);
  }

  createTask(req: CreateTaskRequest): Promise<BridgeTask> {
    return this.request<BridgeTask>("POST", "/api/tasks", req);
  }

  getTask(taskId: string, workspaceId: string): Promise<BridgeTask> {
    const qs = buildQueryString({ workspaceId });
    return this.request<BridgeTask>("GET", `/api/tasks/${encodeURIComponent(taskId)}${qs}`);
  }

  updateTask(taskId: string, workspaceId: string, patch: UpdateTaskRequest): Promise<BridgeTask> {
    const qs = buildQueryString({ workspaceId });
    return this.request<BridgeTask>("PATCH", `/api/tasks/${encodeURIComponent(taskId)}${qs}`, patch);
  }

  cancelTask(taskId: string, workspaceId: string): Promise<BridgeTask> {
    const qs = buildQueryString({ workspaceId });
    return this.request<BridgeTask>("DELETE", `/api/tasks/${encodeURIComponent(taskId)}${qs}`);
  }

  // ─── Bridge chat (per-message claude --print --resume) ────────────────────

  /**
   * Sends one message to a Claude bridge session. If `sessionId` is provided,
   * Claude resumes the prior conversation; otherwise a fresh session is
   * created and the new id is returned in the response.
   */
  bridgeChat(req: BridgeChatRequest): Promise<BridgeChatResponse> {
    return postBridgeChat(this.baseUrl, this.authHeaders(), req);
  }

  submitDirectorGoal = (text: string) => director.submitDirectorGoal(this.boundRequest, text);

  // ─── Projects — what exists here, and bringing something new onto the host ──

  listProjects = () => projects.listProjects(this.boundRequest);
  cloneProject = (req: CloneProjectRequest) => projects.cloneProject(this.boundRequest, req);
  cloneStatus = (taskId: string) => projects.cloneStatus(this.boundRequest, taskId);
  browse = (path?: string) => projects.browse(this.boundRequest, path);
  addProject = (path: string) => projects.addProject(this.boundRequest, path);
  forgetProject = (id: string) => projects.forgetProject(this.boundRequest, id);
}

import { buildQueryString } from "./api-client-util.js";
import type {
  DispatchRequest,
  DispatchResponse,
  ListRunnersResponse,
  SpawnCellRequest,
  SpawnCellResponse,
} from "../types/index.js";

/** `ApiClient.request`, handed in so these stay functions rather than a second client. */
export type CellRequest = <T>(method: string, path: string, body?: unknown) => Promise<T>;


/**
 * Writes `command` to the cell's PTY input. The server answers 404 for an unknown
 * paneId and 410 for one whose cell has exited; both surface as `ApiError` so callers
 * can clear stale focus state.
 */
export function dispatchToCell(
  request: CellRequest,
  req: DispatchRequest,
): Promise<DispatchResponse> {
  return request<DispatchResponse>("POST", "/api/fleet/dispatch", req);
}

/** Pass through the caller's launch permission choice and return once the pane is registered (ADR-8, plans/lotus-pocket). */
export function spawnCell(
  request: CellRequest,
  req: SpawnCellRequest,
): Promise<SpawnCellResponse> {
  return request<SpawnCellResponse>("POST", "/api/fleet/spawn", req);
}

/** A 503 means the operator needs to select a workspace in the desktop window. */
export function closeCell(request: CellRequest, paneId: string): Promise<void> {
  return request<void>("POST", "/api/fleet/close", { paneId });
}

/** Treat 404 as unavailable runner discovery so older desktops aren't mistaken for hosts with no runners. */
export function listRunners(request: CellRequest): Promise<ListRunnersResponse> {
  return request<ListRunnersResponse>("GET", "/api/runners");
}

/** `before`/`limit` for paging backwards through a runner's own transcript (Fase 3). */
export interface TranscriptPage {
  before?: number;
  limit?: number;
}

/** Path for one transcript page. Here rather than in the client for the reason this
 *  module exists: the client sat exactly on the 300-line limit. */
export function transcriptPath(paneId: string, page: TranscriptPage): string {
  return `/api/fleet/${encodeURIComponent(paneId)}/transcript${buildQueryString({ ...page })}`;
}

/** What `POST /api/sessions/:id/size` answers: held, with the lease's token, or lost. */
export interface SizeHeld {
  held: boolean;
  token?: number;
}

/**
 * A phone holds a pane at its own size (ADR-6 addendum 2026-10-05). No `token` starts a hold,
 * a `token` renews it; `held: false` means the desktop took the pane back.
 */
export function holdSessionSize(
  request: CellRequest,
  sessionId: string,
  size: { cols: number; rows: number; token?: number },
): Promise<SizeHeld> {
  return request<SizeHeld>("POST", `/api/sessions/${sessionId}/size`, size);
}

/** The phone left Terminal: the desktop's own size goes back. */
export function releaseSessionSize(request: CellRequest, sessionId: string, token: number): Promise<void> {
  return request<void>("POST", `/api/sessions/${sessionId}/size/release`, { token });
}

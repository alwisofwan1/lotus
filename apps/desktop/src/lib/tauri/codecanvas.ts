import { tauriInvoke } from "@/lib/tauri/runtime";
import type { AgentDefinition, CanvasEdgeRecord, CanvasNodeRecord } from "@/modules/codecanvas/types/canvas";
import type { AgentRunRecord } from "@/modules/codecanvas/services/agent-run-record";
import type { CanvasSessionRecord } from "@/modules/codecanvas/services/session-record";
import type { GraphRunRecord } from "@/modules/codecanvas/services/graph-run-record";
import type { ContextArtifact } from "@/modules/codecanvas/services/context-bus-record";
import type { CanvasStoredTemplate } from "@/modules/codecanvas/types/canvas-team-template";

/**
 * Which machine a project's `rootDir` lives on.
 *
 * Mirrors `CodeCanvasProjectLocation` in `src-tauri/src/codecanvas_store.rs`, and deliberately NOT
 * `CodeSpaceStoredWorkspaceLocation` from `lib/tauri/codespace.ts`: that type carries the working
 * directory inside itself (`cwd` / `remoteCwd`), and a canvas project already has one — `rootDir`.
 * Carrying it twice would let the two disagree. The canvas reads it as a `Machine`
 * (`modules/codecanvas/services/machine.ts`), which is what the SSH-backed calls take.
 */
export type CodeCanvasProjectLocation =
  | { kind: "local" }
  | { kind: "ssh"; host: string; user?: string | null; port?: number | null; label?: string | null };

export interface CodeCanvasProjectMeta {
  id: string;
  rootDir: string;
  alias: string | null;
  position: number;
  updatedAt: number;
  lastOpenedAt: number;
  /** Absent on rows written before the VPS connector; read those as local. */
  location?: CodeCanvasProjectLocation | null;
}

export interface CodeCanvasProjectSnapshot extends CodeCanvasProjectMeta {
  nodes: CanvasNodeRecord[];
  edges: CanvasEdgeRecord[];
  terminalCounter: number;
  noteCounter?: number;
  browserCounter?: number;
  shapeCounter?: number;
}

export interface CodeCanvasProjectIndex {
  projects: CodeCanvasProjectMeta[];
  activeProjectId: string | null;
}

export interface CodeCanvasNoteAsset {
  id: string;
  projectId: string;
  originalName: string;
  fileName: string;
  mime: string;
  byteSize: number;
  createdAt: number;
}

export interface SaveNoteAssetInput {
  projectId: string;
  originalName: string;
  mime: string;
  base64: string;
}

export interface ImportNoteAssetPathInput {
  projectId: string;
  path: string;
}

export interface ReadNoteAssetResult {
  asset: CodeCanvasNoteAsset;
  base64: string;
}

export interface PruneNoteAssetsResult {
  deleted: CodeCanvasNoteAsset[];
}

export interface CodeCanvasMemoryItem {
  id: string;
  projectId: string;
  scopeKind: string;
  scopeId?: string;
  kind: string;
  title?: string;
  body: string;
  summary?: string;
  status?: string;
  importance: number;
  tags: string[];
  metadata: unknown;
  source: string;
  actorId?: string;
  actorKind: string;
  nodeId?: string;
  runId?: string;
  assignmentKey?: string;
  sessionId?: string;
  parentId?: string;
  idempotencyKey?: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export interface CodeCanvasMemoryWriteInput {
  projectId: string;
  scopeKind?: string;
  scopeId?: string | null;
  kind: string;
  title?: string | null;
  body: string;
  summary?: string | null;
  status?: string | null;
  importance?: number | null;
  tags?: string[];
  metadata?: unknown;
  source?: string;
  actorId?: string | null;
  actorKind?: string;
  nodeId?: string | null;
  runId?: string | null;
  assignmentKey?: string | null;
  sessionId?: string | null;
  parentId?: string | null;
  idempotencyKey?: string | null;
  now?: number | null;
}

export interface CodeCanvasMemoryListQuery {
  projectId: string;
  scopeKind?: string | null;
  scopeId?: string | null;
  nodeId?: string | null;
  runId?: string | null;
  assignmentKey?: string | null;
  kinds?: string[];
  includeArchived?: boolean;
  limit?: number | null;
}

export interface CodeCanvasMemorySearchQuery extends CodeCanvasMemoryListQuery {
  query: string;
}

export interface CodeCanvasMemorySearchResult {
  item: CodeCanvasMemoryItem;
  rank: number;
}

export function codecanvasGetIndex(): Promise<CodeCanvasProjectIndex> {
  return tauriInvoke<CodeCanvasProjectIndex>("codecanvas_get_index");
}

export function codecanvasOpenProject(
  rootDir: string,
  location?: CodeCanvasProjectLocation | null,
): Promise<CodeCanvasProjectSnapshot> {
  return tauriInvoke<CodeCanvasProjectSnapshot>("codecanvas_open_project", {
    rootDir,
    location: location ?? null,
  });
}

export function codecanvasLoadProject(projectId: string): Promise<CodeCanvasProjectSnapshot | null> {
  return tauriInvoke<CodeCanvasProjectSnapshot | null>("codecanvas_load_project", { projectId });
}

/**
 * Park a live agent's system prompt on disk, returning its path.
 *
 * The typed launch reads it back with `"$(cat …)"`; see `canvas_write_persona` in `lib.rs` for why
 * a ~3 KB command cannot be typed into a shell.
 */
export function canvasWritePersona(paneId: string, content: string): Promise<string> {
  return tauriInvoke<string>("canvas_write_persona", { paneId, content });
}

export function codecanvasSaveProject(snapshot: CodeCanvasProjectSnapshot): Promise<void> {
  return tauriInvoke<void>("codecanvas_save_project", { snapshot });
}

export function codecanvasRenameProject(projectId: string, alias: string | null): Promise<void> {
  return tauriInvoke<void>("codecanvas_rename_project", { projectId, alias });
}

export function codecanvasCloseProject(projectId: string): Promise<CodeCanvasProjectIndex> {
  return tauriInvoke<CodeCanvasProjectIndex>("codecanvas_close_project", { projectId });
}

export function codecanvasSetActiveProject(projectId: string | null): Promise<void> {
  return tauriInvoke<void>("codecanvas_set_active_project", { projectId });
}

export function codecanvasLoadCollaborationRecord<T = unknown>(projectId: string, runId: string, kind: string): Promise<T | null> {
  return tauriInvoke<T | null>("codecanvas_load_collaboration_record", { projectId, runId, kind });
}

export function codecanvasSaveCollaborationRecord(projectId: string, runId: string, kind: string, payload: unknown): Promise<void> {
  return tauriInvoke<void>("codecanvas_save_collaboration_record", { projectId, runId, kind, payload });
}

export function codecanvasMemoryWrite(input: CodeCanvasMemoryWriteInput): Promise<CodeCanvasMemoryItem> {
  return tauriInvoke<CodeCanvasMemoryItem>("codecanvas_memory_write", { input });
}

export function codecanvasMemoryList(query: CodeCanvasMemoryListQuery): Promise<CodeCanvasMemoryItem[]> {
  return tauriInvoke<CodeCanvasMemoryItem[]>("codecanvas_memory_list", { query });
}

export function codecanvasMemorySearch(query: CodeCanvasMemorySearchQuery): Promise<CodeCanvasMemorySearchResult[]> {
  return tauriInvoke<CodeCanvasMemorySearchResult[]>("codecanvas_memory_search", { query });
}

export function codecanvasMemoryArchive(projectId: string, itemId: string): Promise<void> {
  return tauriInvoke<void>("codecanvas_memory_archive", { projectId, itemId });
}

/** Undo an archive, putting the item back in the hot set agents read. */
export function codecanvasMemoryRestore(projectId: string, itemId: string): Promise<void> {
  return tauriInvoke<void>("codecanvas_memory_restore", { projectId, itemId });
}

/** Pin/unpin an item. Pinned rows are never auto-archived by the retention policy. */
export function codecanvasMemorySetPinned(
  projectId: string,
  itemId: string,
  pinned: boolean,
): Promise<CodeCanvasMemoryItem> {
  return tauriInvoke<CodeCanvasMemoryItem>("codecanvas_memory_set_pinned", { projectId, itemId, pinned });
}

/** Retention maintenance: archive expired/noisy memory for a project. Returns rows archived. */
export function codecanvasMemoryArchiveExpired(projectId: string): Promise<number> {
  return tauriInvoke<number>("codecanvas_memory_archive_expired", { projectId });
}

export function codecanvasSaveNoteAsset(input: SaveNoteAssetInput): Promise<CodeCanvasNoteAsset> {
  return tauriInvoke<CodeCanvasNoteAsset>("codecanvas_save_note_asset", { input });
}

export function codecanvasImportNoteAssetPath(input: ImportNoteAssetPathInput): Promise<CodeCanvasNoteAsset> {
  return tauriInvoke<CodeCanvasNoteAsset>("codecanvas_import_note_asset_path", { input });
}

export function codecanvasListNoteAssets(projectId: string): Promise<CodeCanvasNoteAsset[]> {
  return tauriInvoke<CodeCanvasNoteAsset[]>("codecanvas_list_note_assets", { projectId });
}

export function codecanvasReadNoteAsset(assetId: string): Promise<ReadNoteAssetResult> {
  return tauriInvoke<ReadNoteAssetResult>("codecanvas_read_note_asset", { assetId });
}

/** Absolute on-disk path of a stored note asset — for handing a canvas image to an agent/terminal PTY. */
export function codecanvasNoteAssetPath(assetId: string): Promise<string> {
  return tauriInvoke<string>("codecanvas_note_asset_path", { assetId });
}

/**
 * Stage an asset into a space-free `~/.lotus/agent-drops/<clean-name>` and return that path — a
 * short, readable location to type into an agent prompt (vs the deep app-data path with a space).
 */
export function codecanvasStageNoteAssetForAgent(assetId: string): Promise<string> {
  return tauriInvoke<string>("codecanvas_stage_note_asset_for_agent", { assetId });
}

export function codecanvasDeleteNoteAsset(assetId: string, force = false): Promise<CodeCanvasNoteAsset | null> {
  return tauriInvoke<CodeCanvasNoteAsset | null>("codecanvas_delete_note_asset", { assetId, force });
}

export function codecanvasPruneUnusedNoteAssets(projectId: string): Promise<PruneNoteAssetsResult> {
  return tauriInvoke<PruneNoteAssetsResult>("codecanvas_prune_unused_note_assets", { projectId });
}

export function codecanvasRevealNoteAsset(assetId: string): Promise<void> {
  return tauriInvoke<void>("codecanvas_reveal_note_asset", { assetId });
}

export function codecanvasRevealNoteAssetFolder(projectId: string): Promise<void> {
  return tauriInvoke<void>("codecanvas_reveal_note_asset_folder", { projectId });
}

export function codecanvasListAgents(): Promise<AgentDefinition[]> {
  return tauriInvoke<AgentDefinition[]>("codecanvas_list_agents");
}

export function codecanvasSaveAgent(definition: AgentDefinition): Promise<AgentDefinition> {
  return tauriInvoke<AgentDefinition>("codecanvas_save_agent", { definition });
}

export function codecanvasDeleteAgent(id: string): Promise<void> {
  return tauriInvoke<void>("codecanvas_delete_agent", { id });
}

export function codecanvasListAgentRuns(agentId: string): Promise<AgentRunRecord[]> {
  return tauriInvoke<AgentRunRecord[]>("codecanvas_list_agent_runs", { agentId });
}

export function codecanvasAppendAgentRun(record: AgentRunRecord): Promise<void> {
  return tauriInvoke<void>("codecanvas_append_agent_run", { record });
}

/** Agent sessions for a project, most recently active first (Session Widget, Slice 01). */
export function codecanvasListSessions(projectId: string): Promise<CanvasSessionRecord[]> {
  return tauriInvoke<CanvasSessionRecord[]>("codecanvas_list_sessions", { projectId });
}

/** Rejects when `providerSessionId` is already claimed by another session in the same project. */
export function codecanvasUpsertSession(session: CanvasSessionRecord): Promise<void> {
  return tauriInvoke<void>("codecanvas_upsert_session", { session });
}

export function codecanvasDeleteSession(id: string): Promise<void> {
  return tauriInvoke<void>("codecanvas_delete_session", { id });
}

export function codecanvasSaveGraphRun(record: GraphRunRecord): Promise<void> {
  return tauriInvoke<void>("codecanvas_save_graph_run", { record });
}

export function codecanvasListGraphRuns(projectId: string): Promise<GraphRunRecord[]> {
  return tauriInvoke<GraphRunRecord[]>("codecanvas_list_graph_runs", { projectId });
}

export function codecanvasListAllGraphRuns(): Promise<GraphRunRecord[]> {
  return tauriInvoke<GraphRunRecord[]>("codecanvas_list_all_graph_runs");
}

export function codecanvasGetGraphRun(id: string): Promise<GraphRunRecord | null> {
  return tauriInvoke<GraphRunRecord | null>("codecanvas_get_graph_run", { id });
}

export function codecanvasSaveArtifact(artifact: ContextArtifact): Promise<void> {
  return tauriInvoke<void>("codecanvas_save_artifact", { artifact });
}

export function codecanvasListArtifacts(projectId: string): Promise<ContextArtifact[]> {
  return tauriInvoke<ContextArtifact[]>("codecanvas_list_artifacts", { projectId });
}

export function codecanvasListTemplates(): Promise<CanvasStoredTemplate[]> {
  return tauriInvoke<CanvasStoredTemplate[]>("codecanvas_list_templates");
}

export function codecanvasSaveTemplate(template: CanvasStoredTemplate): Promise<CanvasStoredTemplate> {
  return tauriInvoke<CanvasStoredTemplate>("codecanvas_save_template", { template });
}

export function codecanvasDeleteTemplate(id: string): Promise<void> {
  return tauriInvoke<void>("codecanvas_delete_template", { id });
}

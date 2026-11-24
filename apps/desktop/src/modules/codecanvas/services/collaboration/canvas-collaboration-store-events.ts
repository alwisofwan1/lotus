export const CODECANVAS_COLLABORATION_RECORD_UPDATED_EVENT = "codecanvas://collaboration-record-updated";

export type CanvasCollaborationStorageStatus = "project-synced" | "local-fallback" | "mcp-updated";

export interface CodeCanvasCollaborationRecordUpdatedPayload {
  projectId: string;
  runId: string;
  kind: "ledger" | "mailbox" | string;
  source?: "mcp" | "tauri-command" | string;
}

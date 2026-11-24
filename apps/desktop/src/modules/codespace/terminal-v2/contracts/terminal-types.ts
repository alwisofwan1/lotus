import type { WorkspaceLocation } from "@/modules/codespace/components/types";

export type TerminalV2WorkspaceId = string;
export type TerminalV2PaneId = string;
export type TerminalV2SessionId = string;

export type TerminalV2LaunchKind = "local";

export type TerminalV2RuntimeStatus =
  | "cold"
  | "connecting"
  | "running"
  | "detached"
  | "failed"
  | "exited";

export type TerminalV2RendererStatus =
  | "unbound"
  | "binding"
  | "bound"
  | "releasing";

export type TerminalV2PersistenceMode = "metadata-only";

export type TerminalV2LaunchSpec = {
  kind: TerminalV2LaunchKind;
  cwd: string;
  command?: readonly string[];
  env?: Readonly<Record<string, string>>;
};

export type TerminalV2PaneMetadata = {
  paneId: TerminalV2PaneId;
  workspaceId: TerminalV2WorkspaceId;
  launch: TerminalV2LaunchSpec;
  agentCommand?: string;
  title?: string;
  titleUpdatedAt?: number;
  restoredStatus: Extract<TerminalV2RuntimeStatus, "cold" | "failed">;
};

export type TerminalV2WorkspaceMetadata = {
  workspaceId: TerminalV2WorkspaceId;
  label: string;
  cwd: string;
  location?: WorkspaceLocation;
  terminalPanes: readonly TerminalV2PaneMetadata[];
};

export type TerminalV2MetadataSnapshot = {
  persistenceMode: TerminalV2PersistenceMode;
  source: "codespace-sqlite" | "memory";
  loadedAt: number;
  activeWorkspaceId: TerminalV2WorkspaceId | null;
  focusedPaneId: TerminalV2PaneId | null;
  workspaces: readonly TerminalV2WorkspaceMetadata[];
};

export type TerminalV2RuntimeSession = {
  paneId: TerminalV2PaneId;
  workspaceId: TerminalV2WorkspaceId;
  sessionId: TerminalV2SessionId | null;
  status: TerminalV2RuntimeStatus;
  launch: TerminalV2LaunchSpec;
};

export type TerminalV2RendererLease = {
  paneId: TerminalV2PaneId;
  rendererId: string;
  status: TerminalV2RendererStatus;
  leasedAt: number;
};

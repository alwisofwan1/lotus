import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";
import type { CellBus } from "@/modules/codespace/services/bridge/cell-event-bus";
import type {
  TerminalInputMetadata,
} from "@/modules/codespace/services/terminal-input-events";
import type {
  TerminalRuntimeStatus,
  TerminalSessionSnapshot,
} from "@/modules/codespace/services/terminal-session-registry";
import type {
  TerminalV2RuntimeSession,
  TerminalV2RuntimeStatus,
} from "../contracts/terminal-types";

export type TerminalV2CompatProvider =
  | "shell"
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "cursor"
  | "copilot"
  | "ccs-hss";

export type TerminalV2CompatCreateOptions = {
  paneId: string;
  workspaceId: string;
  cwd: string;
  cols: number;
  rows: number;
  onOutput: (data: string) => void;
  command?: string[];
  claudeAccount?: string;
  location?: CodeSpaceStoredWorkspaceLocation | null;
  canvasTerminalId?: string;
  provider?: TerminalV2CompatProvider;
};

export type TerminalV2CompatSessionHandle = {
  connectPromise: Promise<void>;
  close: () => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  getSessionId: () => string | null;
};

export interface TerminalV2LegacyRuntimePort {
  attachCellBus(bus: CellBus): () => void;
  createSession(options: TerminalV2CompatCreateOptions): TerminalV2CompatSessionHandle;
  closeSession(paneId: string): void;
  markSessionExited(paneId: string): void;
  closeWorkspaceSessions(workspaceId: string): void;
  closeAllSessions(): void;
  hasSession(paneId: string): boolean;
  writeSession(
    paneId: string,
    data: string,
    metadata?: Partial<TerminalInputMetadata>,
  ): void;
  writeSessionConfirmed(
    paneId: string,
    data: string,
    metadata?: Partial<TerminalInputMetadata>,
  ): Promise<void>;
  resizeSession(paneId: string, cols: number, rows: number): void;
  getSessionInput(paneId: string): string;
  attachSession(
    paneId: string,
    onOutput: (data: string) => void,
    expected?: { workspaceId: string; cwd: string },
  ): boolean;
  detachSession(paneId: string): void;
  getSession(paneId: string): TerminalV2RuntimeSession | null;
  getAllSessions(): readonly TerminalV2RuntimeSession[];
  tapOutput(paneId: string, listener: (data: string) => void): () => void;
  subscribeStatus(
    paneId: string,
    subscriber: (status: TerminalV2RuntimeStatus) => void,
  ): () => void;
}

export type LegacyTerminalSessionAdapter = {
  attachCellBus(bus: CellBus): () => void;
  createTerminalSession(options: TerminalV2CompatCreateOptions): TerminalV2CompatSessionHandle;
  closeTerminalSession(paneId: string): void;
  markTerminalSessionExited(paneId: string): void;
  closeWorkspaceTerminalSessions(workspaceId: string): void;
  closeAllTerminalSessions(): void;
  hasTerminalSession(paneId: string): boolean;
  writeTerminalSession(
    paneId: string,
    data: string,
    metadata?: Partial<TerminalInputMetadata>,
  ): void;
  writeTerminalSessionConfirmed(
    paneId: string,
    data: string,
    metadata?: Partial<TerminalInputMetadata>,
  ): Promise<void>;
  resizeTerminalSession(paneId: string, cols: number, rows: number): void;
  getTerminalSessionInput(paneId: string): string;
  attachTerminalSession(
    paneId: string,
    onOutput: (data: string) => void,
    expected?: { workspaceId: string; cwd: string },
  ): boolean;
  detachTerminalSession(paneId: string): void;
  getTerminalRuntimeSessionId(paneId: string): string | null;
  getTerminalSessionStatus(paneId: string): TerminalRuntimeStatus;
  getAllTerminalSessions(): TerminalSessionSnapshot[];
  getWorkspaceTerminalSessions(workspaceId: string): TerminalSessionSnapshot[];
  tapTerminalOutput(paneId: string, listener: (data: string) => void): () => void;
  subscribeTerminalSessionStatus(
    paneId: string,
    subscriber: (status: TerminalRuntimeStatus) => void,
  ): () => void;
};

export function createLegacyTerminalSessionAdapter(
  runtime: TerminalV2LegacyRuntimePort,
): LegacyTerminalSessionAdapter {
  return {
    attachCellBus: (bus) => runtime.attachCellBus(bus),
    createTerminalSession: (options) => runtime.createSession(options),
    closeTerminalSession: (paneId) => runtime.closeSession(paneId),
    markTerminalSessionExited: (paneId) => runtime.markSessionExited(paneId),
    closeWorkspaceTerminalSessions: (workspaceId) => runtime.closeWorkspaceSessions(workspaceId),
    closeAllTerminalSessions: () => runtime.closeAllSessions(),
    hasTerminalSession: (paneId) => runtime.hasSession(paneId),
    writeTerminalSession: (paneId, data, metadata) => runtime.writeSession(paneId, data, metadata),
    writeTerminalSessionConfirmed: (paneId, data, metadata) => runtime.writeSessionConfirmed(paneId, data, metadata),
    resizeTerminalSession: (paneId, cols, rows) => runtime.resizeSession(paneId, cols, rows),
    getTerminalSessionInput: (paneId) => runtime.getSessionInput(paneId),
    attachTerminalSession: (paneId, onOutput, expected) => runtime.attachSession(paneId, onOutput, expected),
    detachTerminalSession: (paneId) => runtime.detachSession(paneId),
    getTerminalRuntimeSessionId: (paneId) => runtime.getSession(paneId)?.sessionId ?? null,
    getTerminalSessionStatus: (paneId) => mapV2StatusToLegacy(runtime.getSession(paneId)?.status ?? "cold"),
    getAllTerminalSessions: () => runtime.getAllSessions().map(toLegacySnapshot),
    getWorkspaceTerminalSessions: (workspaceId) => runtime
      .getAllSessions()
      .filter((session) => session.workspaceId === workspaceId)
      .map(toLegacySnapshot),
    tapTerminalOutput: (paneId, listener) => runtime.tapOutput(paneId, listener),
    subscribeTerminalSessionStatus: (paneId, subscriber) => runtime.subscribeStatus(
      paneId,
      (status) => subscriber(mapV2StatusToLegacy(status)),
    ),
  };
}

export function mapV2StatusToLegacy(status: TerminalV2RuntimeStatus): TerminalRuntimeStatus {
  switch (status) {
    case "cold":
      return "idle";
    case "connecting":
      return "starting";
    case "running":
      return "live";
    case "detached":
      return "detached";
    case "failed":
      return "failed";
    case "exited":
      return "exited";
  }
}

export function mapLegacyStatusToV2(status: TerminalRuntimeStatus): TerminalV2RuntimeStatus {
  switch (status) {
    case "idle":
      return "cold";
    case "starting":
      return "connecting";
    case "live":
      return "running";
    case "detached":
      return "detached";
    case "failed":
      return "failed";
    case "exited":
      return "exited";
  }
}

function toLegacySnapshot(session: TerminalV2RuntimeSession): TerminalSessionSnapshot {
  return {
    paneId: session.paneId,
    workspaceId: session.workspaceId,
    cwd: session.launch.cwd,
    status: mapV2StatusToLegacy(session.status),
    sessionId: session.sessionId,
  };
}

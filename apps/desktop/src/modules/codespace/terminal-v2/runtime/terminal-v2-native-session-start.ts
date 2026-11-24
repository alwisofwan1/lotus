import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";
import {
  resolveTerminalV2InitialGeometryEvent,
  type TerminalV2InitialGeometryDecision,
} from "../geometry/terminal-v2-geometry-event-adapter";
import type { TerminalV2SessionStartOutcome } from "./terminal-v2-session-starter";

export type TerminalV2NativeSessionStarter = {
  start(request: {
    paneId: string;
    workspaceId: string;
    cwd: string;
    geometry: { cols: number; rows: number };
    onOutput: (data: string) => void;
    command?: string[];
    claudeAccount?: string;
    location?: CodeSpaceStoredWorkspaceLocation | null;
  }): Promise<TerminalV2SessionStartOutcome>;
};

export type TerminalV2NativeSessionTerminal = {
  cols?: number;
  rows?: number;
};

export type StartTerminalV2NativeSessionOptions = {
  claudeAccount?: string;
  container: { getBoundingClientRect(): { width: number; height: number } };
  cwd: string;
  disposed?: () => boolean;
  handleOutput: (data: string) => void;
  initialCommand?: string;
  isLive?: () => boolean;
  location?: CodeSpaceStoredWorkspaceLocation | null;
  notifyRuntimeStatus: (status: "starting" | "live" | "failed") => void;
  onRuntimeSessionIdChange?: (sessionId: string | null) => void;
  paneId: string;
  resolveInitialGeometryEvent?: (geometry: {
    cols: number;
    rows: number;
    width: number;
    height: number;
  } | null) => TerminalV2InitialGeometryDecision;
  sendInitialCommand: (created: boolean) => void;
  sessionStarter?: TerminalV2NativeSessionStarter;
  setLive: (live: boolean) => void;
  terminal: TerminalV2NativeSessionTerminal;
  terminalCommand?: string[];
  workspaceId: string;
  writeConnectFailure: (error: unknown) => void;
};

export function startTerminalV2NativeSession({
  claudeAccount,
  container,
  cwd,
  disposed = () => false,
  handleOutput,
  isLive = () => false,
  location,
  notifyRuntimeStatus,
  onRuntimeSessionIdChange,
  paneId,
  resolveInitialGeometryEvent = resolveTerminalV2InitialGeometryEvent,
  sendInitialCommand,
  sessionStarter,
  setLive,
  terminal,
  terminalCommand,
  workspaceId,
  writeConnectFailure,
}: StartTerminalV2NativeSessionOptions): boolean {
  const cols = Number.isFinite(terminal.cols) ? terminal.cols : null;
  const rows = Number.isFinite(terminal.rows) ? terminal.rows : null;
  const bounds = container.getBoundingClientRect();
  const initialGeometry = cols && rows
    ? { cols, rows, width: bounds.width, height: bounds.height }
    : null;
  const initialDecision = resolveInitialGeometryEvent(initialGeometry);
  if (initialDecision.kind !== "start-session" || !sessionStarter) return false;

  if (!isLive()) notifyRuntimeStatus("starting");
  void sessionStarter.start({
    paneId,
    workspaceId,
    cwd,
    geometry: { cols: initialDecision.geometry.cols, rows: initialDecision.geometry.rows },
    onOutput: handleOutput,
    command: terminalCommand,
    claudeAccount,
    location,
  }).then((outcome) => {
    if (disposed()) return;
    setLive(true);
    onRuntimeSessionIdChange?.(outcome.sessionId);
    notifyRuntimeStatus("live");
    sendInitialCommand(outcome.kind === "created");
  }).catch((error: unknown) => {
    if (disposed()) return;
    setLive(false);
    notifyRuntimeStatus("failed");
    writeConnectFailure(error);
  });
  return true;
}

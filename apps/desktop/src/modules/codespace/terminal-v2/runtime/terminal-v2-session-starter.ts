import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";
import type {
  TerminalV2CreateSessionOptions,
  TerminalV2SessionHandle,
  TerminalV2SessionProvider,
} from "./terminal-v2-session-manager";

export type TerminalV2Geometry = {
  cols: number;
  rows: number;
};

export type TerminalV2SessionStartRequest = {
  paneId: string;
  workspaceId: string;
  cwd: string;
  geometry: TerminalV2Geometry;
  onOutput: (data: string) => void;
  command?: string[];
  provider?: TerminalV2SessionProvider;
  claudeAccount?: string;
  location?: CodeSpaceStoredWorkspaceLocation | null;
  canvasTerminalId?: string;
};

export type TerminalV2SessionStartOutcome =
  | { kind: "reattached"; sessionId: string | null }
  | { kind: "created"; sessionId: string | null };

export interface TerminalV2SessionStarterPort {
  attachSession(
    paneId: string,
    onOutput: (data: string) => void,
    expected: { workspaceId: string; cwd: string },
  ): boolean;
  createSession(options: TerminalV2CreateSessionOptions): TerminalV2SessionHandle;
  getSessionId(paneId: string): string | null;
  resizeSession(paneId: string, cols: number, rows: number): void;
  /** Resize, and force a repaint even when the size is unchanged. */
  resizeSessionAndRedraw(paneId: string, cols: number, rows: number): void;
}

export class TerminalV2SessionStarter {
  constructor(private readonly sessions: TerminalV2SessionStarterPort) {}

  async start(request: TerminalV2SessionStartRequest): Promise<TerminalV2SessionStartOutcome> {
    const { paneId, workspaceId, cwd, geometry, onOutput } = request;
    const reattached = this.sessions.attachSession(paneId, onOutput, { workspaceId, cwd });

    if (reattached) {
      // The renderer is new and empty while the PTY kept its size, so a plain (deduped) resize
      // would send nothing and the agent would never repaint it.
      this.sessions.resizeSessionAndRedraw(paneId, geometry.cols, geometry.rows);
      return {
        kind: "reattached",
        sessionId: this.sessions.getSessionId(paneId),
      };
    }

    const handle = this.sessions.createSession({
      paneId,
      workspaceId,
      cwd,
      cols: geometry.cols,
      rows: geometry.rows,
      onOutput,
      command: request.command,
      claudeAccount: request.claudeAccount,
      provider: request.provider,
      location: request.location,
      canvasTerminalId: request.canvasTerminalId,
    });
    await handle.connectPromise;

    if (handle.adopted()) {
      // Found running in the session daemon: the same as a reattach, so nothing is launched
      // into it, and the size it kept from the old pane is replaced and redrawn.
      this.sessions.resizeSessionAndRedraw(paneId, geometry.cols, geometry.rows);
      return { kind: "reattached", sessionId: this.sessions.getSessionId(paneId) };
    }

    return {
      kind: "created",
      sessionId: this.sessions.getSessionId(paneId),
    };
  }
}

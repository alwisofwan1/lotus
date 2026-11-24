import { PtySessionController } from "@/lib/pty-session-controller";
import { parsePtySessionEnd } from "@/lib/pty-session-end";
import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";
import type {
  CellBus,
  CellBusEventName,
  CellBusEvents,
} from "@/modules/codespace/services/bridge/cell-event-bus";
import type { TerminalInputMetadata } from "@/modules/codespace/services/terminal-input-events";
import { DEFAULT_TERMINAL_INPUT_METADATA } from "@/modules/codespace/services/terminal-input-events";
import { reduceInlineTerminalInput } from "@/modules/codespace/services/terminal-inline-suggestions";
import type {
  TerminalV2LaunchSpec,
  TerminalV2RuntimeSession,
  TerminalV2RuntimeStatus,
} from "../contracts/terminal-types";
import { resizeAndRedraw } from "./terminal-v2-session-redraw";
import { mapV2StatusToLegacy } from "../compat/legacy-terminal-session-adapter";

export type TerminalV2SessionController = {
  connect: (
    cwd: string,
    cols: number,
    rows: number,
    onOutput: (data: string) => void,
    paneId?: string,
    location?: CodeSpaceStoredWorkspaceLocation | null,
    canvasTerminalId?: string,
  ) => Promise<void>;
  connectToCommand?: (
    cwd: string,
    command: string[],
    cols: number,
    rows: number,
    onOutput: (data: string) => void,
    paneId?: string,
    location?: CodeSpaceStoredWorkspaceLocation | null,
  ) => Promise<void>;
  write: (data: string) => void;
  writeConfirmed?: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => void;
  abort: () => void;
  getSessionId: () => string | null;
  /** True once connected to a session that was already running (session daemon adopt). */
  wasAdopted?: () => boolean;
};

export type TerminalV2SessionProvider =
  | "shell"
  | "claude"
  | "codex"
  | "gemini"
  | "opencode"
  | "cursor"
  | "copilot"
  | "ccs-hss";

export type TerminalV2CreateSessionOptions = {
  paneId: string;
  workspaceId: string;
  cwd: string;
  cols: number;
  rows: number;
  onOutput: (data: string) => void;
  command?: string[];
  location?: CodeSpaceStoredWorkspaceLocation | null;
  canvasTerminalId?: string;
  provider?: TerminalV2SessionProvider;
  claudeAccount?: string;
  controller?: TerminalV2SessionController;
};

export type TerminalV2SessionHandle = {
  connectPromise: Promise<void>;
  close: () => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  getSessionId: () => string | null;
  adopted: () => boolean;
};

type TerminalV2SessionRecord = TerminalV2RuntimeSession & {
  controller: TerminalV2SessionController;
  onOutput?: (data: string) => void;
  geometry: { cols: number; rows: number };
};

type TerminalV2SessionManagerOptions = { controllerFactory?: (claudeAccount: string | null) => TerminalV2SessionController; };

export class TerminalV2SessionManager {
  private sessions = new Map<string, TerminalV2SessionRecord>();
  private statuses = new Map<string, TerminalV2RuntimeStatus>();
  private subscribers = new Map<string, Set<(status: TerminalV2RuntimeStatus) => void>>();
  private taps = new Map<string, Set<(data: string) => void>>();
  private inputs = new Map<string, string>();
  private buses = new Set<CellBus>();
  private readonly controllerFactory: (claudeAccount: string | null) => TerminalV2SessionController;

  constructor(options: TerminalV2SessionManagerOptions = {}) {
    this.controllerFactory = options.controllerFactory ?? ((claudeAccount) => new PtySessionController(claudeAccount));
  }

  attachCellBus(bus: CellBus): () => void {
    this.buses.add(bus);
    return () => {
      this.buses.delete(bus);
    };
  }

  createSession(options: TerminalV2CreateSessionOptions): TerminalV2SessionHandle {
    this.closeSession(options.paneId);

    const controller = options.controller ?? this.controllerFactory(options.claudeAccount ?? null);
    const launch = this.buildLaunchSpec(options);
    const record: TerminalV2SessionRecord = {
      paneId: options.paneId,
      workspaceId: options.workspaceId,
      sessionId: null,
      status: "connecting",
      launch,
      controller,
      onOutput: options.onOutput,
      geometry: { cols: options.cols, rows: options.rows },
    };

    this.sessions.set(options.paneId, record);
    this.setStatus(options.paneId, "connecting");
    this.emit("terminal:spawned", {
      paneId: options.paneId,
      workspaceId: options.workspaceId,
      cwd: options.cwd,
      provider: options.provider,
    });

    const connect = this.connectController(options, controller, (data) => {
      record.onOutput?.(data);
      this.taps.get(options.paneId)?.forEach((tap) => tap(data));
      this.emit("terminal:output", {
        paneId: options.paneId,
        workspaceId: options.workspaceId,
        data,
      });
      // The process is gone: drop the record, or the pane's next start reattaches to the dead PTY.
      if (parsePtySessionEnd(data) !== null && this.sessions.get(options.paneId) === record) this.markSessionExited(options.paneId);
    });

    const connectPromise = connect
      .then(() => {
        if (this.sessions.get(options.paneId) !== record) return;
        record.sessionId = controller.getSessionId();
        this.setStatus(options.paneId, record.onOutput ? "running" : "detached");
      })
      .catch((error) => {
        if (this.sessions.get(options.paneId) === record) {
          this.sessions.delete(options.paneId);
          this.setStatus(options.paneId, "failed");
        }
        throw error;
      });

    return {
      connectPromise,
      close: () => this.closeSession(options.paneId),
      write: (data) => this.writeSession(options.paneId, data),
      resize: (cols, rows) => this.resizeSession(options.paneId, cols, rows),
      getSessionId: () => this.sessions.get(options.paneId)?.controller.getSessionId() ?? null,
      adopted: () => controller.wasAdopted?.() ?? false,
    };
  }

  closeSession(paneId: string): void {
    const record = this.sessions.get(paneId);
    if (!record) return;
    record.controller.abort();
    this.sessions.delete(paneId);
    // Taps belong to the bound renderer, which outlives a restart (account move); it unsubscribes itself.
    this.inputs.delete(paneId);
    this.setStatus(paneId, "exited");
    this.emit("terminal:exited", { paneId, workspaceId: record.workspaceId });
  }

  closeWorkspaceSessions(workspaceId: string): void {
    for (const record of Array.from(this.sessions.values())) {
      if (record.workspaceId === workspaceId) this.closeSession(record.paneId);
    }
  }

  closeAllSessions(): void {
    for (const paneId of Array.from(this.sessions.keys())) this.closeSession(paneId);
  }

  hasSession(paneId: string): boolean {
    return this.sessions.has(paneId);
  }

  attachSession(
    paneId: string,
    onOutput: (data: string) => void,
    expected?: { workspaceId: string; cwd: string },
  ): boolean {
    const record = this.sessions.get(paneId);
    if (!record) return false;
    // Reattach identity is (workspaceId, paneId) only. cwd is intentionally excluded:
    // the live shell reports directory changes and agents cd / switch worktrees, so the
    // pane's cwd drifts from `record.launch.cwd` (the immutable spawn cwd). Gating on cwd
    // made drifted terminals fail to reattach after a canvas project switch and spawn a
    // fresh PTY — the "session reset" bug. Mirrors terminal-session-registry.attachTerminalSession.
    if (expected && record.workspaceId !== expected.workspaceId) {
      return false;
    }
    record.onOutput = onOutput;
    this.setStatus(paneId, "running");
    return true;
  }

  detachSession(paneId: string): void {
    const record = this.sessions.get(paneId);
    if (!record) return;
    record.onOutput = undefined;
    this.setStatus(paneId, "detached");
  }

  markSessionExited(paneId: string): void {
    const record = this.sessions.get(paneId);
    const workspaceId = record?.workspaceId;
    this.sessions.delete(paneId);
    this.inputs.delete(paneId);
    this.setStatus(paneId, "exited");
    if (workspaceId) this.emit("terminal:exited", { paneId, workspaceId });
  }

  writeSession(paneId: string, data: string, metadata: Partial<TerminalInputMetadata> = {}): void {
    const record = this.sessions.get(paneId);
    if (!record) return;
    record.controller.write(data);
    const currentInput = this.inputs.get(paneId) ?? "";
    const nextInput = reduceInlineTerminalInput(currentInput, data, [], record.launch.cwd).nextInput;
    this.inputs.set(paneId, nextInput);
    this.emit("terminal:input", {
      paneId,
      workspaceId: record.workspaceId,
      data,
      ...DEFAULT_TERMINAL_INPUT_METADATA,
      ...metadata,
    });
  }

  async writeSessionConfirmed(
    paneId: string,
    data: string,
    metadata: Partial<TerminalInputMetadata> = {},
  ): Promise<void> {
    const record = this.sessions.get(paneId);
    if (!record || (record.status !== "running" && record.status !== "detached")) {
      throw new Error("Terminal session is not writable.");
    }
    if (!record.controller.writeConfirmed) {
      throw new Error("Terminal session does not support confirmed writes.");
    }
    await record.controller.writeConfirmed(data);
    const currentInput = this.inputs.get(paneId) ?? "";
    const nextInput = reduceInlineTerminalInput(currentInput, data, [], record.launch.cwd).nextInput;
    this.inputs.set(paneId, nextInput);
    this.emit("terminal:input", {
      paneId,
      workspaceId: record.workspaceId,
      data,
      ...DEFAULT_TERMINAL_INPUT_METADATA,
      ...metadata,
    });
  }

  resizeSession(paneId: string, cols: number, rows: number): void {
    const record = this.sessions.get(paneId);
    if (!record) return;
    record.geometry = { cols, rows };
    // Not deduped here: the controller dedupes against what the PTY accepted, so a failed or
    // dropped resize is retried on the next fit instead of being skipped forever.
    record.controller.resize(cols, rows);
  }

  /** Resize, and force a repaint even when the size is unchanged; see `resizeAndRedraw`. */
  resizeSessionAndRedraw(paneId: string, cols: number, rows: number): void {
    const current = () => this.sessions.get(paneId);
    resizeAndRedraw(paneId, cols, rows, { current, resize: (c, r) => this.resizeSession(paneId, c, r) });
  }

  getSessionId(paneId: string): string | null {
    return this.sessions.get(paneId)?.controller.getSessionId() ?? null;
  }

  getSessionInput(paneId: string): string {
    return this.inputs.get(paneId) ?? "";
  }

  getSession(paneId: string): TerminalV2RuntimeSession | null {
    const record = this.sessions.get(paneId);
    if (!record) return null;
    return this.snapshot(record);
  }

  getAllSessions(): readonly TerminalV2RuntimeSession[] {
    return Array.from(this.sessions.values()).map((record) => this.snapshot(record));
  }

  subscribeOutput(paneId: string, listener: (data: string) => void): () => void {
    const taps = this.taps.get(paneId) ?? new Set<(data: string) => void>();
    taps.add(listener);
    this.taps.set(paneId, taps);
    return () => {
      taps.delete(listener);
      if (taps.size === 0) this.taps.delete(paneId);
    };
  }

  tapOutput(paneId: string, listener: (data: string) => void): () => void {
    return this.subscribeOutput(paneId, listener);
  }

  subscribeStatus(paneId: string, subscriber: (status: TerminalV2RuntimeStatus) => void): () => void {
    const subscribers = this.subscribers.get(paneId) ?? new Set<(status: TerminalV2RuntimeStatus) => void>();
    subscribers.add(subscriber);
    this.subscribers.set(paneId, subscribers);
    subscriber(this.statuses.get(paneId) ?? "cold");
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.subscribers.delete(paneId);
    };
  }

  dispose(): void {
    this.closeAllSessions();
    this.subscribers.clear();
    this.buses.clear();
  }

  private setStatus(paneId: string, status: TerminalV2RuntimeStatus): void {
    const previous = this.statuses.get(paneId) ?? "cold";
    this.statuses.set(paneId, status);
    const record = this.sessions.get(paneId);
    if (record) record.status = status;
    this.subscribers.get(paneId)?.forEach((subscriber) => subscriber(status));
    if (previous !== status) {
      this.emit("terminal:status", { paneId, status: mapV2StatusToLegacy(status) });
    }
  }

  private emit<K extends CellBusEventName>(event: K, payload: CellBusEvents[K]): void {
    for (const bus of this.buses) bus.emit(event, payload);
  }

  private buildLaunchSpec(options: TerminalV2CreateSessionOptions): TerminalV2LaunchSpec {
    return {
      kind: "local",
      cwd: options.cwd,
      ...(options.command ? { command: options.command } : {}),
    };
  }

  private connectController(
    options: TerminalV2CreateSessionOptions,
    controller: TerminalV2SessionController,
    onOutput: (data: string) => void,
  ): Promise<void> {
    if (options.command) {
      if (!controller.connectToCommand) {
        return Promise.reject(new Error("terminal controller does not support command sessions"));
      }
      return controller.connectToCommand(options.cwd, options.command, options.cols, options.rows, onOutput, options.paneId, options.location);
    }
    return controller.connect(
      options.cwd,
      options.cols,
      options.rows,
      onOutput,
      options.paneId,
      options.location,
      options.canvasTerminalId,
    );
  }

  private snapshot(record: TerminalV2SessionRecord): TerminalV2RuntimeSession {
    return {
      paneId: record.paneId,
      workspaceId: record.workspaceId,
      sessionId: record.controller.getSessionId(),
      status: record.status,
      launch: record.launch,
    };
  }
}

// One mapping, kept beside the compat layer that owns the legacy statuses.
export { mapV2StatusToLegacy };

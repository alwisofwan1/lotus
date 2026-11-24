import { PtySessionController } from "@/lib/pty-session-controller";
import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";
import type { CellBus, CellBusEventName, CellBusEvents } from "@/modules/codespace/services/bridge/cell-event-bus";
import {
  DEFAULT_TERMINAL_INPUT_METADATA,
  type TerminalInputMetadata,
} from "@/modules/codespace/services/terminal-input-events";
import { reduceInlineTerminalInput } from "@/modules/codespace/services/terminal-inline-suggestions";
import {
  attachTerminalV2LegacyCellBus,
  clearTerminalV2LegacySessionAdapterForTests,
  getTerminalV2LegacySessionAdapter,
} from "@/modules/codespace/terminal-v2/compat/terminal-session-registry-bridge";
import type { LegacyTerminalSessionAdapter } from "@/modules/codespace/terminal-v2/compat/legacy-terminal-session-adapter";
import { resolveTerminalSessionCreateRoute } from "@/modules/codespace/terminal-v2/compat/terminal-session-routing-policy";

export type TerminalRuntimeStatus = "idle" | "starting" | "live" | "detached" | "exited" | "failed";

export type TerminalSessionSnapshot = {
  paneId: string;
  workspaceId: string;
  cwd?: string;
  status: TerminalRuntimeStatus;
  sessionId?: string | null;
  canvasTerminalId?: string;
};

const attachedBuses = new Set<CellBus>();

export function attachCellBus(bus: CellBus): () => void {
  attachedBuses.add(bus);
  const detachV2Bus = attachTerminalV2LegacyCellBus(bus);
  return () => {
    attachedBuses.delete(bus);
    detachV2Bus();
  };
}

function emitBus<K extends CellBusEventName>(event: K, payload: CellBusEvents[K]): void {
  for (const bus of attachedBuses) {
    bus.emit(event, payload);
  }
}

type TerminalSessionController = {
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
};

type TerminalSessionRegistration = {
  workspaceId: string;
  cwd?: string;
  status: TerminalRuntimeStatus;
  canvasTerminalId?: string;
  close: () => void;
  write?: (data: string) => void;
  writeConfirmed?: (data: string) => Promise<void>;
  resize?: (cols: number, rows: number) => void;
  getSessionId?: () => string | null;
  onOutput?: (data: string) => void;
};

type CreateTerminalSessionOptions = {
  paneId: string;
  workspaceId: string;
  cwd: string;
  cols: number;
  rows: number;
  onOutput: (data: string) => void;
  command?: string[];
  /** Lotus Claude account the PTY runs on (issues/07). */
  claudeAccount?: string;
  /** Workspace location metadata retained for compatibility with callers. */
  location?: CodeSpaceStoredWorkspaceLocation | null;
  /** Canvas Terminal Node ID. When set, injects AGENT_CANVAS_* env vars into the PTY process. */
  canvasTerminalId?: string;
  /**
   * Agent CLI this session is running, if any. Forwarded to the
   * `terminal:spawned` bus event so consumers (e.g. auto-dismiss welcome
   * dialogs, MCP fleet) can react per-provider without needing to re-derive
   * it from the workspace state.
   */
  provider?:
    | "shell"
    | "claude"
    | "codex"
    | "gemini"
    | "opencode"
    | "cursor"
    | "copilot"
    | "ccs-hss";
  controller?: TerminalSessionController;
};

type TerminalSessionHandle = {
  connectPromise: Promise<void>;
  close: () => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  getSessionId: () => string | null;
};

const terminalSessions = new Map<string, TerminalSessionRegistration>();
const terminalSessionStatuses = new Map<string, TerminalRuntimeStatus>();
const terminalSessionStatusSubscribers = new Map<string, Set<(status: TerminalRuntimeStatus) => void>>();
const terminalOutputTaps = new Map<string, Set<(data: string) => void>>();
const terminalSessionInputs = new Map<string, string>();
/**
 * Bounded rolling mirror of everything each pane's PTY has emitted, kept so a
 * freshly-mounted xterm can be repainted on reattach (project switch A→B→A).
 * Appended on every dispatched chunk — including while the pane is detached —
 * so a switch never drops the screen. Runtime replays it raw into the (already
 * fit) terminal; it deliberately does NOT flow back through the semantic output
 * processor (no re-fired cwd/OSC133/auto-trust side effects on replay).
 */
const MAX_TERMINAL_TRANSCRIPT_BYTES = 256_000;
const terminalTranscripts = new Map<string, string>();

function appendTerminalTranscript(paneId: string, data: string): void {
  if (!data) return;
  const prev = terminalTranscripts.get(paneId) ?? "";
  terminalTranscripts.set(paneId, `${prev}${data}`.slice(-MAX_TERMINAL_TRANSCRIPT_BYTES));
}

function getV2AdapterForPane(paneId: string): LegacyTerminalSessionAdapter | null {
  const adapter = getTerminalV2LegacySessionAdapter();
  return adapter?.hasTerminalSession(paneId) ? adapter : null;
}

function getLegacyTerminalSessionSnapshots(): TerminalSessionSnapshot[] {
  const snapshots: TerminalSessionSnapshot[] = [];
  for (const [paneId, registration] of terminalSessions) {
    snapshots.push({
      paneId,
      workspaceId: registration.workspaceId,
      cwd: registration.cwd,
      status: registration.status,
      sessionId: registration.getSessionId?.() ?? null,
      canvasTerminalId: registration.canvasTerminalId,
    });
  }
  return snapshots;
}

function mergeTerminalSessionSnapshots(v2Snapshots: TerminalSessionSnapshot[]): TerminalSessionSnapshot[] {
  const v2PaneIds = new Set(v2Snapshots.map((snapshot) => snapshot.paneId));
  return [
    ...getLegacyTerminalSessionSnapshots().filter((snapshot) => !v2PaneIds.has(snapshot.paneId)),
    ...v2Snapshots,
  ];
}

function setTerminalSessionStatus(paneId: string, status: TerminalRuntimeStatus) {
  const prev = terminalSessionStatuses.get(paneId) ?? "idle";
  terminalSessionStatuses.set(paneId, status);
  const registration = terminalSessions.get(paneId);
  if (registration) {
    registration.status = status;
  }
  terminalSessionStatusSubscribers.get(paneId)?.forEach((subscriber) => subscriber(status));
  if (prev !== status) {
    emitBus("terminal:status", { paneId, status });
  }
}

export function createTerminalSession({
  paneId,
  workspaceId,
  cwd,
  cols,
  rows,
  onOutput,
  command,
  provider,
  claudeAccount,
  controller = new PtySessionController(claudeAccount ?? null),
  location,
  canvasTerminalId,
}: CreateTerminalSessionOptions): TerminalSessionHandle {
  const v2 = getTerminalV2LegacySessionAdapter();
  if (v2 && resolveTerminalSessionCreateRoute({ location, canvasTerminalId }) === "v2") {
    return v2.createTerminalSession({
      paneId,
      workspaceId,
      cwd,
      cols,
      rows,
      onOutput,
      command,
      location,
      canvasTerminalId,
      provider,
      claudeAccount,
    });
  }

  closeTerminalSession(paneId);

  const registration: TerminalSessionRegistration = {
    workspaceId,
    cwd,
    status: "starting",
    canvasTerminalId,
    close: () => controller.abort(),
    write: (data) => controller.write(data),
    writeConfirmed: controller.writeConfirmed
      ? (data) => controller.writeConfirmed!(data)
      : undefined,
    resize: (nextCols, nextRows) => controller.resize(nextCols, nextRows),
    getSessionId: () => controller.getSessionId(),
    onOutput,
  };
  terminalSessions.set(paneId, registration);
  setTerminalSessionStatus(paneId, "starting");
  emitBus("terminal:spawned", { paneId, workspaceId, cwd, provider });

  const dispatchOutput = (data: string) => {
    appendTerminalTranscript(paneId, data);
    registration.onOutput?.(data);
    terminalOutputTaps.get(paneId)?.forEach((tap) => tap(data));
    emitBus("terminal:output", { paneId, workspaceId, data });
  };

  const connect = command
    ? controller.connectToCommand?.(cwd, command, cols, rows, dispatchOutput, paneId, location) ??
      Promise.reject(new Error("terminal controller does not support command sessions"))
    : controller.connect(cwd, cols, rows, dispatchOutput, paneId, location, canvasTerminalId);

  const connectPromise = connect.then(() => {
    if (terminalSessions.get(paneId) === registration) {
      setTerminalSessionStatus(paneId, registration.onOutput ? "live" : "detached");
    }
  }).catch((error) => {
    if (terminalSessions.get(paneId) === registration) {
      terminalSessions.delete(paneId);
      setTerminalSessionStatus(paneId, "failed");
    }
    throw error;
  });

  return {
    connectPromise,
    close: registration.close,
    write: (data) => registration.write?.(data),
    resize: (nextCols, nextRows) => registration.resize?.(nextCols, nextRows),
    getSessionId: () => registration.getSessionId?.() ?? null,
  };
}

export function registerTerminalSession(
  paneId: string,
  registration: TerminalSessionRegistration,
): () => void {
  terminalSessions.set(paneId, registration);
  setTerminalSessionStatus(paneId, registration.status);
  return () => {
    if (terminalSessions.get(paneId) === registration) {
      terminalSessions.delete(paneId);
    }
  };
}

export function closeTerminalSession(paneId: string): void {
  const v2 = getV2AdapterForPane(paneId);
  if (v2) return v2.closeTerminalSession(paneId);

  const registration = terminalSessions.get(paneId);
  if (!registration) return;
  const workspaceId = registration.workspaceId;
  registration.close();
  terminalSessions.delete(paneId);
  terminalOutputTaps.delete(paneId);
  terminalSessionInputs.delete(paneId);
  terminalTranscripts.delete(paneId);
  setTerminalSessionStatus(paneId, "exited");
  emitBus("terminal:exited", { paneId, workspaceId });
}

export function tapTerminalOutput(paneId: string, listener: (data: string) => void): () => void {
  const v2 = getTerminalV2LegacySessionAdapter();
  const detachV2Tap = v2?.tapTerminalOutput(paneId, listener) ?? null;

  let taps = terminalOutputTaps.get(paneId);
  if (!taps) {
    taps = new Set();
    terminalOutputTaps.set(paneId, taps);
  }
  taps.add(listener);
  return () => {
    const set = terminalOutputTaps.get(paneId);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) terminalOutputTaps.delete(paneId);
    detachV2Tap?.();
  };
}

export function markTerminalSessionExited(paneId: string): void {
  const v2 = getV2AdapterForPane(paneId);
  if (v2) return v2.markTerminalSessionExited(paneId);

  const registration = terminalSessions.get(paneId);
  const workspaceId = registration?.workspaceId;
  terminalSessions.delete(paneId);
  terminalSessionInputs.delete(paneId);
  terminalTranscripts.delete(paneId);
  setTerminalSessionStatus(paneId, "exited");
  if (workspaceId) {
    emitBus("terminal:exited", { paneId, workspaceId });
  }
}

export function detachTerminalSession(paneId: string): void {
  const v2 = getV2AdapterForPane(paneId);
  if (v2) return v2.detachTerminalSession(paneId);

  const registration = terminalSessions.get(paneId);
  if (!registration) return;
  registration.onOutput = undefined;
  setTerminalSessionStatus(paneId, "detached");
}

export function attachTerminalSession(
  paneId: string,
  onOutput: (data: string) => void,
  expected?: { workspaceId: string; cwd: string },
): boolean {
  const v2 = getV2AdapterForPane(paneId);
  if (v2) return v2.attachTerminalSession(paneId, onOutput, expected);

  const registration = terminalSessions.get(paneId);
  if (!registration) return false;
  // Reattach identity is (workspaceId, paneId) — both stable for a pane's lifetime.
  // cwd is deliberately NOT part of the guard: a live shell reports directory changes
  // (OSC 7/133) and agents `cd` / switch worktrees, so the pane's persisted cwd drifts
  // away from the session's spawn cwd. Gating on cwd made every drifted terminal fail to
  // reattach after a canvas project switch and spawn a fresh PTY — the "session reset"
  // bug. workspaceId still guards against attaching to a pane owned by another workspace.
  if (expected && registration.workspaceId !== expected.workspaceId) {
    return false;
  }
  registration.onOutput = onOutput;
  setTerminalSessionStatus(paneId, "live");
  return true;
}

export function hasTerminalSession(paneId: string): boolean {
  return terminalSessions.has(paneId) || Boolean(getV2AdapterForPane(paneId));
}

/**
 * The pane's rolling output mirror, for reattach replay. Non-consuming (safe to
 * read repeatedly). Empty string when no session/history exists, or when the
 * pane is owned by the Terminal V2 adapter (which mirrors its own transcript).
 */
export function peekTerminalTranscript(paneId: string): string {
  if (getV2AdapterForPane(paneId)) return "";
  return terminalTranscripts.get(paneId) ?? "";
}

export function writeTerminalSession(
  paneId: string,
  data: string,
  metadata: Partial<TerminalInputMetadata> = {},
): void {
  const v2 = getV2AdapterForPane(paneId);
  if (v2) return v2.writeTerminalSession(paneId, data, metadata);

  const registration = terminalSessions.get(paneId);
  if (!registration) return;
  registration.write?.(data);
  const currentInput = terminalSessionInputs.get(paneId) ?? "";
  const nextInput = reduceInlineTerminalInput(currentInput, data, [], registration.cwd).nextInput;
  terminalSessionInputs.set(paneId, nextInput);
  const inputMetadata = {
    ...DEFAULT_TERMINAL_INPUT_METADATA,
    ...metadata,
  };
  emitBus("terminal:input", {
    paneId,
    workspaceId: registration.workspaceId,
    data,
    ...inputMetadata,
  });
}

export async function writeTerminalSessionConfirmed(
  paneId: string,
  data: string,
  metadata: Partial<TerminalInputMetadata> = {},
): Promise<void> {
  const v2 = getV2AdapterForPane(paneId);
  if (v2) return v2.writeTerminalSessionConfirmed(paneId, data, metadata);

  const registration = terminalSessions.get(paneId);
  if (!registration || (registration.status !== "live" && registration.status !== "detached")) {
    throw new Error("Terminal session is not writable.");
  }
  if (!registration.writeConfirmed) {
    throw new Error("Terminal session does not support confirmed writes.");
  }
  await registration.writeConfirmed(data);
  const currentInput = terminalSessionInputs.get(paneId) ?? "";
  const nextInput = reduceInlineTerminalInput(currentInput, data, [], registration.cwd).nextInput;
  terminalSessionInputs.set(paneId, nextInput);
  emitBus("terminal:input", {
    paneId,
    workspaceId: registration.workspaceId,
    data,
    ...DEFAULT_TERMINAL_INPUT_METADATA,
    ...metadata,
  });
}

export function getTerminalSessionInput(paneId: string): string {
  const v2 = getV2AdapterForPane(paneId);
  if (v2) return v2.getTerminalSessionInput(paneId);
  return terminalSessionInputs.get(paneId) ?? "";
}

export function resizeTerminalSession(paneId: string, cols: number, rows: number): void {
  const v2 = getV2AdapterForPane(paneId);
  if (v2) return v2.resizeTerminalSession(paneId, cols, rows);
  terminalSessions.get(paneId)?.resize?.(cols, rows);
}

export function getTerminalRuntimeSessionId(paneId: string): string | null {
  const v2 = getV2AdapterForPane(paneId);
  if (v2) return v2.getTerminalRuntimeSessionId(paneId);
  return terminalSessions.get(paneId)?.getSessionId?.() ?? null;
}

export function getTerminalSessionStatus(paneId: string): TerminalRuntimeStatus {
  const v2 = getV2AdapterForPane(paneId);
  if (v2) return v2.getTerminalSessionStatus(paneId);
  return terminalSessionStatuses.get(paneId) ?? "idle";
}

export function subscribeTerminalSessionStatus(
  paneId: string,
  subscriber: (status: TerminalRuntimeStatus) => void,
): () => void {
  const v2 = getTerminalV2LegacySessionAdapter();
  const unsubscribeV2 = v2?.subscribeTerminalSessionStatus(paneId, subscriber) ?? null;

  let subscribers = terminalSessionStatusSubscribers.get(paneId);
  if (!subscribers) {
    subscribers = new Set();
    terminalSessionStatusSubscribers.set(paneId, subscribers);
  }
  subscribers.add(subscriber);
  subscriber(getTerminalSessionStatus(paneId));

  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      terminalSessionStatusSubscribers.delete(paneId);
    }
    unsubscribeV2?.();
  };
}

export function closeWorkspaceTerminalSessions(workspaceId: string): void {
  getTerminalV2LegacySessionAdapter()?.closeWorkspaceTerminalSessions(workspaceId);

  for (const [paneId, registration] of terminalSessions) {
    if (registration.workspaceId !== workspaceId) continue;
    registration.close();
    terminalSessions.delete(paneId);
    terminalSessionInputs.delete(paneId);
    setTerminalSessionStatus(paneId, "exited");
    emitBus("terminal:exited", { paneId, workspaceId });
  }
}

export function closeAllTerminalSessions(): void {
  getTerminalV2LegacySessionAdapter()?.closeAllTerminalSessions();

  for (const [paneId, registration] of terminalSessions) {
    const workspaceId = registration.workspaceId;
    registration.close();
    terminalSessions.delete(paneId);
    terminalSessionInputs.delete(paneId);
    setTerminalSessionStatus(paneId, "exited");
    emitBus("terminal:exited", { paneId, workspaceId });
  }
}

export function getAllTerminalSessions(): TerminalSessionSnapshot[] {
  return mergeTerminalSessionSnapshots(
    getTerminalV2LegacySessionAdapter()?.getAllTerminalSessions() ?? [],
  );
}

export function getWorkspaceTerminalSessions(workspaceId: string): TerminalSessionSnapshot[] {
  return getAllTerminalSessions().filter((s) => s.workspaceId === workspaceId);
}

export function clearTerminalSessionRegistryForTests(): void {
  clearTerminalV2LegacySessionAdapterForTests();
  terminalSessions.clear();
  terminalSessionStatuses.clear();
  terminalSessionStatusSubscribers.clear();
  terminalOutputTaps.clear();
  terminalSessionInputs.clear();
  terminalTranscripts.clear();
  attachedBuses.clear();
}

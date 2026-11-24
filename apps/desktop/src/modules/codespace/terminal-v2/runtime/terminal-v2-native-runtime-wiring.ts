import type { UseLegacyTerminalRuntimeOptions } from "@/modules/codespace/hooks/useLegacyTerminalRuntime";
import { noteTerminalOutputChunk, noteTerminalUserInput } from "@/modules/codespace/services/terminal-activity-registry";
import type { TerminalRuntimeStatus } from "@/modules/codespace/services/terminal-session-registry";
import { createTerminalV2PtyResizeDebouncer, type TerminalV2PtyResizeDebouncer } from "../geometry/terminal-v2-geometry-event-adapter";
import { sendTerminalV2NativeInitialCommand } from "./terminal-v2-native-initial-command";
import { createTerminalV2NativeInputHandler } from "./terminal-v2-native-input";
import { createTerminalV2NativeOutputHandler } from "./terminal-v2-native-output";
import { createTerminalV2NativeResizeBinding, type TerminalV2NativeResizeBinding } from "./terminal-v2-native-resize";
import { notifyTerminalV2NativeSearchReady } from "./terminal-v2-native-search";
import { startTerminalV2NativeSession } from "./terminal-v2-native-session-start";

type RefCell<T> = { current: T };
type TerminalV2NativeRenderer = Awaited<ReturnType<NonNullable<UseLegacyTerminalRuntimeOptions["rendererFactory"]>>>;

const NATIVE_AGENT_PTY_RESIZE_DEBOUNCE_MS = 900;

export type TerminalV2NativeRuntimeWiringHandles = {
  terminal: { cols?: number; rows?: number; focus?: () => void };
  fitAddon: { fit(): void };
};

export type TerminalV2NativeRuntimeWiring = {
  handles: TerminalV2NativeRuntimeWiringHandles;
  helperTextarea: HTMLTextAreaElement | null;
  resizeBinding: TerminalV2NativeResizeBinding;
  dispose(): void;
  startSession(): void;
};

export type CreateTerminalV2NativeRuntimeWiringOptions = Pick<
  UseLegacyTerminalRuntimeOptions,
  | "active"
  | "agentCommand"
  | "claudeAccount"
  | "cwd"
  | "history"
  | "initialCommand"
  | "location"
  | "onCurrentDirectoryChange"
  | "onExit"
  | "onInlineCommandSubmit"
  | "onRuntimeSessionIdChange"
  | "onTerminalCustomKey"
  | "paneId"
  | "terminalCommand"
  | "workspaceId"
> & {
  clearTimer?: (handle: unknown) => void;
  container: HTMLDivElement;
  disposed: () => boolean;
  lastFittedGeometryRef: RefCell<{ cols: number | null; rows: number | null }>;
  legacyOptions: Partial<UseLegacyTerminalRuntimeOptions>;
  liveResizeActiveRef: RefCell<boolean>;
  nativeSessionLiveRef: RefCell<boolean>;
  notifiedSearchAddonRef: RefCell<object | null>;
  notifyRuntimeStatus: (status: TerminalRuntimeStatus) => void;
  renderer: TerminalV2NativeRenderer;
  resizeDebouncerRef: RefCell<TerminalV2PtyResizeDebouncer | null>;
  sentInitialCommandKeysRef: RefCell<Set<string>>;
  setHasRendered: (rendered: boolean) => void;
  setTimer?: (callback: () => void, ms: number) => unknown;
};

export function createTerminalV2NativeRuntimeWiring({
  active,
  agentCommand,
  claudeAccount,
  clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  container,
  cwd,
  disposed,
  history,
  initialCommand,
  lastFittedGeometryRef,
  legacyOptions,
  liveResizeActiveRef,
  location,
  nativeSessionLiveRef,
  notifiedSearchAddonRef,
  notifyRuntimeStatus,
  onCurrentDirectoryChange,
  onExit,
  onInlineCommandSubmit,
  onRuntimeSessionIdChange,
  onTerminalCustomKey,
  paneId,
  renderer,
  resizeDebouncerRef,
  sentInitialCommandKeysRef,
  setHasRendered,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  terminalCommand,
  workspaceId,
}: CreateTerminalV2NativeRuntimeWiringOptions): TerminalV2NativeRuntimeWiring {
  const handles = { terminal: renderer.terminal, fitAddon: renderer.addons.fitAddon };
  const handlesCleanup = legacyOptions.onRendererHandlesReady?.(handles);
  const disposeHandles = typeof handlesCleanup === "function" ? handlesCleanup : undefined;

  notifyTerminalV2NativeSearchReady({
    notifiedSearchAddonRef,
    onSearchReady: legacyOptions.onSearchReady,
    searchAddon: renderer.addons.searchAddon,
    terminal: renderer.terminal,
  });

  const writeScheduler = legacyOptions.writeSchedulerFactory?.({
    paneId,
    write: (data, callback) => {
      renderer.terminal.write?.(data, callback);
      if (!renderer.terminal.write) callback();
    },
    refresh: () => renderer.terminal.refresh?.(0, Math.max(0, (renderer.terminal.rows ?? 1) - 1)),
  });

  const standbyBacklog = legacyOptions.rendererStandbyBacklog;
  const outputHandler = createTerminalV2NativeOutputHandler({
    cwd,
    onCurrentDirectoryChange,
    notifyRuntimeStatus,
    onExit,
    onRuntimeSessionIdChange,
    noteOutputChunk: (visibleData) => noteTerminalOutputChunk(paneId, visibleData),
    processOutput: legacyOptions.outputEventProcessor,
    scheduler: writeScheduler,
    ...(standbyBacklog ? {
      standbyBacklog: {
        isActive: () => standbyBacklog.isActive(paneId),
        append: (data: string) => standbyBacklog.append(paneId, data),
      },
    } : {}),
    setLive: (live) => {
      nativeSessionLiveRef.current = live;
    },
  });

  const inputHandler = createTerminalV2NativeInputHandler({
    agentCommand,
    cwd,
    history,
    noteUserInput: noteTerminalUserInput,
    onInlineCommandSubmit,
    paneId,
    processInput: legacyOptions.inputEventProcessor,
    sessionWriter: legacyOptions.sessionWriter,
    suggestionAdapter: legacyOptions.suggestionAdapter,
  });
  const unregisterInputPipeline = legacyOptions.paneInputPipeline?.register(paneId, inputHandler.handleInput);

  const resizeDebouncer = createTerminalV2PtyResizeDebouncer({
    delayMs: agentCommand ? NATIVE_AGENT_PTY_RESIZE_DEBOUNCE_MS : undefined,
    onResize: (cols, rows) => legacyOptions.sessionResizer?.resize(paneId, cols, rows),
    setTimer,
    clearTimer,
  });
  resizeDebouncerRef.current = resizeDebouncer;

  const resizeBinding = createTerminalV2NativeResizeBinding({
    active: active !== false,
    fitAddon: renderer.addons.fitAddon,
    isLiveResizeActive: () => liveResizeActiveRef.current,
    isRendererStandby: () => standbyBacklog?.isActive(paneId) ?? false,
    lastFittedGeometryRef,
    resizeDebouncer,
    resolveResizeEvent: legacyOptions.geometryEventAdapter?.resolveResizeEvent,
    suggestionAdapter: legacyOptions.suggestionAdapter,
    terminal: renderer.terminal,
  });
  renderer.addons.fitAddon.fit();
  resizeBinding.updateLastFittedGeometry();

  const eventSubscription = legacyOptions.rendererEventAdapter?.({
    terminal: renderer.terminal,
    handlers: {
      onData: inputHandler.handleInput,
      onRender: () => setHasRendered(true),
      onWriteParsed: () => {},
      onCustomKey: (event) => onTerminalCustomKey?.(event) ?? true,
    },
  });

  return {
    handles,
    helperTextarea: renderer.helperTextarea,
    resizeBinding,
    dispose() {
      eventSubscription?.dispose();
      // This renderer is going away; whatever it parked while on standby belongs to it alone.
      standbyBacklog?.clear(paneId);
      unregisterInputPipeline?.();
      inputHandler.dispose();
      resizeDebouncer.cancel();
      if (resizeDebouncerRef.current === resizeDebouncer) {
        resizeDebouncerRef.current = null;
      }
      writeScheduler?.dispose();
      disposeHandles?.();
    },
    startSession() {
      startTerminalV2NativeSession({
        container,
        cwd,
        disposed,
        handleOutput: outputHandler.handleOutput,
        isLive: () => nativeSessionLiveRef.current,
        location,
        notifyRuntimeStatus,
        onRuntimeSessionIdChange,
        paneId,
        resolveInitialGeometryEvent: legacyOptions.geometryEventAdapter?.resolveInitialGeometryEvent,
        sendInitialCommand: (created) => sendTerminalV2NativeInitialCommand({
          created,
          initialCommand,
          paneId,
          sentKeys: sentInitialCommandKeysRef.current,
          terminalCommand,
          write: legacyOptions.sessionWriter?.write,
        }),
        sessionStarter: legacyOptions.sessionStarter,
        setLive: (live) => {
          nativeSessionLiveRef.current = live;
        },
        claudeAccount,
        terminal: renderer.terminal,
        terminalCommand,
        workspaceId,
        writeConnectFailure: (error) => {
          renderer.terminal.write?.(`\r\n\x1b[31m[PTY connect failed]\x1b[0m \x1b[2m${String(error)}\x1b[0m\r\n`);
        },
      });
    },
  };
}

"use client";
import { terminalOscLinkHandler } from "@/lib/terminal-web-links";

import { parsePtySessionEnd } from "@/lib/pty-session-end";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TerminalTheme } from "@/lib/design-system";
import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";
import type { TerminalLinkContextMenuPayload } from "@/modules/codespace/services/terminal-addons";
import { activateWebglRenderer, loadTerminalAddons, type TerminalAddons } from "@/modules/codespace/services/terminal-addons";
import { providerFromAgentCommand } from "@/modules/codespace/services/terminal-provider-detection";
import { reduceInlineTerminalInput } from "@/modules/codespace/services/terminal-inline-suggestions";
import { getSuggestionRemainder } from "@/modules/codespace/services/terminal-suggestions";
import { handleTerminalCustomKeyEvent, type TerminalShortcutEvent } from "@/modules/codespace/services/terminal-keybindings";
import {
  createTerminalSearchOptions,
  hasVisibleTerminalSearchSelection,
  repaintTerminalSearchSelection,
  selectTerminalSearchFallbackMatch,
  type TerminalSearchMode,
} from "@/modules/codespace/services/terminal-search-options";
import {
  extractSubmittedTerminalPrompt,
  type TerminalInputMetadata,
} from "@/modules/codespace/services/terminal-input-events";
import { seedPanePrompt } from "@/modules/codespace/services/pane-prompt-buffer";
import { detectMonoFontFamily } from "@/lib/fonts";
import { TerminalDormantRing } from "@/modules/codespace/services/terminal-dormant-ring";
import { TerminalPaneRuntime, type TerminalPaneHost } from "@/modules/codespace/services/terminal-pane-runtime";
import { resolveCodeSpaceTerminalRenderMetrics } from "@/modules/codespace/services/codespace-terminal-render-theme";
import { shouldDemoteTerminalWebglForEligibility } from "@/modules/codespace/services/terminal-webgl-policy";
import {
  hasTerminalObservedSizeChanged,
  measureTerminalGeometry,
  shouldSkipFit,
  type TerminalGeometry,
  type TerminalObservedSize,
} from "@/modules/codespace/services/terminal-geometry";
import { subscribeLegacyTerminalGridLiveResize } from "@/modules/codespace/services/legacy-terminal-grid-resize-events";
import {
  createTerminalWriteScheduler,
  type TerminalWriteFn,
  type TerminalWriteScheduler,
} from "@/modules/codespace/services/terminal-write-scheduler";
import { createTerminalWriteMetricsObserver } from "@/modules/codespace/services/terminal-write-metrics";
import { extractTerminalCwdUpdates } from "@/modules/codespace/services/terminal-cwd-probe";
import { parseOsc133, type Osc133Event } from "@/modules/codespace/services/terminal-osc133";
import { isAgentReadyLine, isWorkingStatusLine } from "@/modules/codespace/services/terminal-status-lines";
import {
  noteTerminalCommandBoundary,
  noteTerminalOutputChunk,
  noteTerminalUserInput,
  noteTerminalAgentStandby,
  resetTerminalActivity,
  subscribeTerminalActivity,
} from "@/modules/codespace/services/terminal-activity-registry";
import { getTrustedTerminalDirs, rememberTrustedTerminalDir } from "@/modules/codespace/services/terminal-trust";
import { rendererPool } from "@/modules/codespace/services/terminal-renderer-pool";
import {
  attachTerminalSession,
  createTerminalSession,
  detachTerminalSession,
  getTerminalRuntimeSessionId,
  markTerminalSessionExited,
  peekTerminalTranscript,
  resizeTerminalSession,
  subscribeTerminalSessionStatus,
  type TerminalRuntimeStatus,
  writeTerminalSession,
} from "@/modules/codespace/services/terminal-session-registry";

type TerminalSearchAPI = {
  findNext: (query: string, mode?: TerminalSearchMode) => boolean;
  findPrevious: (query: string) => boolean;
  clearSearch: () => void;
};

type LegacyTerminalRuntimeSessionStartOutcome = {
  kind: "reattached" | "created";
  sessionId: string | null;
};

type LegacyTerminalRuntimeSessionDetacher = {
  detach(paneId: string): void;
};

type LegacyTerminalRuntimeHiddenOutputBuffer = {
  append(data: string): void;
  drain(write: (chunk: string) => void): void;
  hasData(): boolean;
  clear(): void;
};

type LegacyTerminalRuntimeRendererHandles = {
  terminal: {
    reset(): void;
    write(data: string): void;
    refresh(start: number, end: number): void;
    rows: number;
  };
  fitAddon: { fit(): void };
};

type LegacyTerminalRuntimeRenderer = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  terminal: any;
  addons: TerminalAddons;
  helperTextarea: HTMLTextAreaElement | null;
  dispose: () => void;
};

type LegacyTerminalRuntimeRendererFactory = (request: {
  container: HTMLDivElement;
  cwd: string;
  fontSize: number;
  terminalTheme?: TerminalTheme;
  allowTransparency: boolean;
  isDisposed: () => boolean;
  onLinkContextMenu: (payload: TerminalLinkContextMenuPayload) => void;
}) => Promise<LegacyTerminalRuntimeRenderer>;

type LegacyTerminalRuntimeRendererEventHandlers = {
  onData: (data: string) => void;
  onRender: () => void;
  onWriteParsed: () => void;
  onCustomKey: (event: KeyboardEvent) => boolean;
};

type LegacyTerminalRuntimeRendererEventAdapter = (request: {
  terminal: LegacyTerminalRuntimeRenderer["terminal"];
  handlers: LegacyTerminalRuntimeRendererEventHandlers;
  onDisposeError?: (error: unknown, source: string) => void;
}) => { dispose(): void };

type LegacyTerminalRuntimeInputEventProcessor = (request: {
  currentInput: string;
  data: string;
  history: string[];
  cwd: string;
  agentCommand?: string;
}) => {
  nextInput: string;
  suggestionRemainder: string;
  submittedPrompt: string;
  writeRequest: {
    data: string;
    metadata: TerminalInputMetadata;
  } | null;
};

type LegacyTerminalRuntimeOutputEventProcessor = (request: {
  data: string;
  paneRuntimeState: string;
  trustPromptSeen: boolean;
  cwd: string;
  cwdTrusted: boolean;
  hasActiveSuggestionRemainder: boolean;
}) => {
  visibleData: string;
  cwdUpdates: string[];
  osc133Events: Osc133Event[];
  exitCode: number | null;
  outputRoute: "visible" | "hidden" | "none";
  nextTrustPromptSeen: boolean;
  autoTrustResponse: string | null;
  rememberTrustedCwd: boolean;
  resizeAfterTrust: boolean;
  scheduleSuggestionLayout: boolean;
};

type LegacyTerminalRuntimeGeometryEventAdapter = {
  resolveResizeEvent(input: {
    active: boolean;
    liveResizeActive: boolean;
    lastFittedCols: number | null;
    lastFittedRows: number | null;
    proposedCols?: number | null;
    proposedRows?: number | null;
  }): { kind: "ignore" | "skip-fit" | "fit"; reason?: string };
  resolveInitialGeometryEvent(geometry: TerminalGeometry | null):
    | { kind: "defer-start" }
    | { kind: "start-session"; geometry: TerminalGeometry };
  resolveCommitFitEvent(input: { active: boolean }): { kind: "ignore" | "fit-and-flush"; reason?: string };
};

type LegacyTerminalRuntimePaneRuntimePort = Pick<TerminalPaneRuntime,
  | "getSnapshot"
  | "isLiveResizing"
  | "init"
  | "notifyXtermCreated"
  | "notifyAttached"
  | "setVisible"
  | "notifyRendererPromoting"
  | "notifyRendererPromoted"
  | "notifyRendererPromotionFailed"
  | "notifyRendererDemoted"
  | "notifyRendererLost"
  | "notifyLiveResizeStart"
  | "notifyLiveResizeEnd"
  | "dispose"
>;

type LegacyTerminalRuntimePaneRuntimeFactory = (request: {
  host: TerminalPaneHost;
  initiallyVisible: boolean;
}) => LegacyTerminalRuntimePaneRuntimePort;

type LegacyTerminalRuntimeWriteSchedulerFactory = (request: {
  paneId: string;
  write: TerminalWriteFn;
  refresh: () => void;
}) => TerminalWriteScheduler;

type LegacyTerminalRuntimeSessionStarter = {
  start: (request: {
    paneId: string;
    workspaceId: string;
    cwd: string;
    geometry: { cols: number; rows: number };
    onOutput: (data: string) => void;
    command?: string[];
    provider?: ReturnType<typeof providerFromAgentCommand>;
    claudeAccount?: string;
    location?: CodeSpaceStoredWorkspaceLocation | null;
    canvasTerminalId?: string;
  }) => Promise<LegacyTerminalRuntimeSessionStartOutcome>;
};

type LegacyTerminalRuntimeSessionResizer = {
  resize: (paneId: string, cols: number, rows: number) => void;
};

type LegacyTerminalRuntimeSessionWriter = {
  write: typeof writeTerminalSession;
};

type LegacyTerminalRuntimeRevealPolicy = {
  resolve(input: {
    active: boolean;
    hasTerminal: boolean;
    hasRenderedOnce: boolean;
    currentGeneration: number;
  }): {
    generation: number;
    revealState: TerminalRevealState;
    cancelSettle: boolean;
    scheduleFallback: boolean;
  };
};

type LegacyTerminalRuntimeSuggestionAdapter = {
  remainderChanged(remainder: string): void;
  layoutChanged(): void;
};

type LegacyTerminalRuntimeLinkContextAdapter = {
  openContextMenu(payload: TerminalLinkContextMenuPayload, containerRect: DOMRect | null): void;
};

/**
 * Seam for surfaces where a *different* renderer can take over a pane (Terminal V2's pooled xterm
 * slots). While that is the case this hook's own xterm must stop parsing live output — otherwise
 * every PTY byte is parsed twice — and park it in the pane's bounded rehydration ring instead, so a
 * fallback rebind can replay it. Surfaces with a single renderer (CodeCanvas) leave this unset.
 */
export type LegacyTerminalRuntimeRendererStandbyBacklog = {
  isActive(paneId: string): boolean;
  append(paneId: string, data: string): void;
  /** Drops parked output when this renderer goes away; the next one starts with an empty buffer. */
  clear(paneId: string): void;
};

/**
 * Seam for publishing this pane's input pipeline — inline suggestions, submitted-command
 * detection, activity tracking, cwd probing — so a renderer this hook does not own can feed
 * keystrokes through the same processing instead of writing raw bytes to the PTY.
 */
export type LegacyTerminalRuntimePaneInputPipeline = {
  register(paneId: string, handleInput: (data: string) => void): () => void;
};

export type TerminalRevealState = "hidden" | "warming" | "settled";

export type UseLegacyTerminalRuntimeOptions = {
  active?: boolean;
  workspaceId: string;
  paneId: string;
  cwd: string;
  fontSize: number;
  history: string[];
  onExit?: (code: number) => void;
  onRuntimeSessionIdChange?: (sessionId: string | null) => void;
  onRuntimeStatusChange?: (status: TerminalRuntimeStatus) => void;
  onInlineCommandSubmit?: (command: string) => void;
  initialCommand?: string;
  terminalTheme?: TerminalTheme;
  /** True only for the pane that owns keyboard focus inside a visible terminal layout. */
  focused?: boolean;
  allowTransparency?: boolean;
  onSearchReady?: (api: TerminalSearchAPI) => void;
  onSuggestionRemainderChange?: (remainder: string) => void;
  onSuggestionLayoutChange?: () => void;
  onLinkContextMenu?: (payload: TerminalLinkContextMenuPayload) => void;
  onCurrentDirectoryChange?: (cwd: string) => void;
  terminalCommand?: string[];
  /** Lotus Claude account the PTY runs on (issues/07); local spawns only. */
  claudeAccount?: string;
  agentCommand?: string;
  /** Workspace location metadata retained for compatibility with callers. */
  location?: CodeSpaceStoredWorkspaceLocation | null;
  /** Canvas Terminal Node ID. When set, injects AGENT_CANVAS_* env vars. */
  canvasTerminalId?: string;
  /** Optional V2 session-start policy seam. Renderer logic remains owned by this hook for now. */
  sessionStarter?: LegacyTerminalRuntimeSessionStarter;
  /** Optional V2 session-resize policy seam. Renderer logic remains owned by this hook for now. */
  sessionResizer?: LegacyTerminalRuntimeSessionResizer;
  /** Optional V2 session-write policy seam. Input parsing remains owned by this hook for now. */
  sessionWriter?: LegacyTerminalRuntimeSessionWriter;
  /** Optional V2 session-detach seam. Renderer cleanup must detach UI output without closing PTY. */
  sessionDetacher?: LegacyTerminalRuntimeSessionDetacher;
  /** Optional V2 reveal policy seam. DOM writes remain owned by this hook for now. */
  revealPolicy?: LegacyTerminalRuntimeRevealPolicy;
  /** Optional V2 suggestion adapter seam. Inline parsing remains owned by this hook for now. */
  suggestionAdapter?: LegacyTerminalRuntimeSuggestionAdapter;
  /** Optional V2 link context adapter seam. Link detection remains owned by this hook for now. */
  linkContextAdapter?: LegacyTerminalRuntimeLinkContextAdapter;
  /** Optional V2 hidden-output buffer seam. Renderer logic remains owned by this hook for now. */
  hiddenOutputBufferFactory?: () => LegacyTerminalRuntimeHiddenOutputBuffer;
  /** True for the focused visible pane selected for accelerated rendering. */
  renderAccelerationEligible?: boolean;
  /** True while a parent pane split is being dragged live. */
  liveResizeActive?: boolean;
  /** Optional renderer factory seam used by Terminal V2 to own xterm construction while legacy orchestration migrates. */
  rendererFactory?: LegacyTerminalRuntimeRendererFactory;
  /** Optional renderer event seam used by Terminal V2 to own xterm event subscriptions while orchestration migrates. */
  rendererEventAdapter?: LegacyTerminalRuntimeRendererEventAdapter;
  /** Optional input processor seam used by Terminal V2 to own xterm input semantics while orchestration migrates. */
  inputEventProcessor?: LegacyTerminalRuntimeInputEventProcessor;
  /** Optional output processor seam used by Terminal V2 to own PTY output semantics while orchestration migrates. */
  outputEventProcessor?: LegacyTerminalRuntimeOutputEventProcessor;
  /** Optional geometry policy seam used by Terminal V2 to own resize decisions while orchestration migrates. */
  geometryEventAdapter?: LegacyTerminalRuntimeGeometryEventAdapter;
  /** Optional pane lifecycle seam used by Terminal V2 to own pane runtime creation while orchestration migrates. */
  paneRuntimeFactory?: LegacyTerminalRuntimePaneRuntimeFactory;
  /** Optional write scheduler seam used by Terminal V2 to own output backpressure while orchestration migrates. */
  writeSchedulerFactory?: LegacyTerminalRuntimeWriteSchedulerFactory;
  /** Optional standby seam: parks live output while another renderer owns the pane. */
  rendererStandbyBacklog?: LegacyTerminalRuntimeRendererStandbyBacklog;
  /** Optional seam: publishes this pane's input pipeline for renderers this hook does not own. */
  paneInputPipeline?: LegacyTerminalRuntimePaneInputPipeline;
  /** Optional pane-level shortcut seam that runs before terminal word-navigation keybindings. */
  onTerminalCustomKey?: (event: TerminalShortcutEvent) => boolean | undefined;
  /**
   * Optional Shift+Enter → newline seam: return the sequence to write instead of a plain Enter,
   * or null to leave the key untouched (read live so a settings toggle applies without a remount).
   */
  shiftEnterNewline?: () => string | null;
  /** Optional V2 renderer-host seam. Does not change legacy renderer ownership. */
  onRendererHandlesReady?: (handles: LegacyTerminalRuntimeRendererHandles) => void | (() => void);
};

// DormantRing: 16 KB blocks × 64 blocks = 1 MB cap. Overflowed blocks are
// dropped oldest-first; a dim notice is prepended on drain; no \x1bc reset.
const DORMANT_RING_MAX_BLOCKS = 64;
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const DEFAULT_REVEAL_POLICY: LegacyTerminalRuntimeRevealPolicy = {
  resolve({ active, hasTerminal, hasRenderedOnce, currentGeneration }) {
    const generation = currentGeneration + 1;
    if (!active) {
      return { generation, revealState: "hidden", cancelSettle: true, scheduleFallback: false };
    }
    if (!hasTerminal) {
      return { generation, revealState: "warming", cancelSettle: false, scheduleFallback: false };
    }
    if (hasRenderedOnce) {
      return { generation, revealState: "settled", cancelSettle: true, scheduleFallback: false };
    }
    return { generation, revealState: "warming", cancelSettle: false, scheduleFallback: true };
  },
};

const DEFAULT_INPUT_EVENT_PROCESSOR: LegacyTerminalRuntimeInputEventProcessor = ({
  currentInput,
  data,
  history,
  cwd,
  agentCommand,
}) => {
  const reduced = reduceInlineTerminalInput(currentInput, data, history, cwd);
  const submittedPrompt = extractSubmittedTerminalPrompt(data, currentInput);
  const suggestionRemainder = reduced.suggestion
    ? getSuggestionRemainder(reduced.nextInput, reduced.suggestion.command)
    : "";

  return {
    nextInput: reduced.nextInput,
    suggestionRemainder,
    submittedPrompt,
    writeRequest: reduced.writeData
      ? {
          data: reduced.writeData,
          metadata: {
            origin: "human",
            intent: submittedPrompt && agentCommand?.trim()
              ? "conversation-prompt"
              : "unknown",
            submitted: Boolean(submittedPrompt),
            promptText: submittedPrompt || undefined,
          },
        }
      : null,
  };
};

const DEFAULT_OUTPUT_EVENT_PROCESSOR: LegacyTerminalRuntimeOutputEventProcessor = ({
  data,
  paneRuntimeState,
  trustPromptSeen,
  cwdTrusted,
  hasActiveSuggestionRemainder,
}) => {
  const exitCode = parsePtySessionEnd(data);
  if (exitCode !== null) {
    return {
      visibleData: "",
      cwdUpdates: [],
      osc133Events: [],
      exitCode,
      outputRoute: "none",
      nextTrustPromptSeen: trustPromptSeen,
      autoTrustResponse: null,
      rememberTrustedCwd: false,
      resizeAfterTrust: false,
      scheduleSuggestionLayout: false,
    };
  }

  const cwdResult = extractTerminalCwdUpdates(data);
  const { visibleData, events: osc133Events } = parseOsc133(cwdResult.visibleData);
  const outputRoute = visibleData
    ? (paneRuntimeState === "ready_visible" ? "visible" : "hidden")
    : "none";
  const sawTrustPrompt = !trustPromptSeen && /trust.*folder|folder.*trust/i.test(visibleData);
  const rememberTrustedCwd = /i trust this folder|trust this folder/i.test(visibleData);

  return {
    visibleData,
    cwdUpdates: cwdResult.cwdUpdates,
    osc133Events,
    exitCode: null,
    outputRoute,
    nextTrustPromptSeen: trustPromptSeen || sawTrustPrompt,
    autoTrustResponse: sawTrustPrompt && cwdTrusted ? "1\r" : null,
    rememberTrustedCwd,
    resizeAfterTrust: rememberTrustedCwd,
    scheduleSuggestionLayout: outputRoute === "visible" && hasActiveSuggestionRemainder,
  };
};

const DEFAULT_GEOMETRY_EVENT_ADAPTER: LegacyTerminalRuntimeGeometryEventAdapter = {
  resolveResizeEvent(input) {
    if (!input.active) return { kind: "ignore", reason: "inactive" };
    if (input.liveResizeActive) return { kind: "ignore", reason: "live-resize" };
    if (shouldSkipFit(input.lastFittedCols, input.lastFittedRows, input.proposedCols, input.proposedRows)) {
      return { kind: "skip-fit" };
    }
    return { kind: "fit" };
  },
  resolveInitialGeometryEvent(geometry) {
    return geometry ? { kind: "start-session", geometry } : { kind: "defer-start" };
  },
  resolveCommitFitEvent(input) {
    return input.active ? { kind: "fit-and-flush" } : { kind: "ignore", reason: "inactive" };
  },
};

async function waitForTerminalFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  try {
    await document.fonts.ready;
  } catch {
    // Best effort: xterm can still render with the fallback stack.
  }
}

export function useLegacyTerminalRuntime({
  active = true,
  workspaceId,
  paneId,
  cwd,
  fontSize,
  history,
  onExit,
  onRuntimeSessionIdChange,
  onRuntimeStatusChange,
  onInlineCommandSubmit,
  initialCommand,
  terminalTheme,
  allowTransparency = false,
  onSearchReady,
  onSuggestionRemainderChange,
  onSuggestionLayoutChange,
  onLinkContextMenu,
  onCurrentDirectoryChange,
  terminalCommand,
  claudeAccount,
  agentCommand,
  location,
  canvasTerminalId,
  sessionStarter,
  sessionResizer,
  sessionWriter,
  revealPolicy,
  suggestionAdapter,
  linkContextAdapter,
  hiddenOutputBufferFactory,
  renderAccelerationEligible = false,
  rendererFactory,
  rendererEventAdapter,
  inputEventProcessor,
  outputEventProcessor,
  geometryEventAdapter,
  paneRuntimeFactory,
  writeSchedulerFactory,
  onTerminalCustomKey,
  shiftEnterNewline,
  onRendererHandlesReady,
}: UseLegacyTerminalRuntimeOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [revealState, setRevealState] = useState<TerminalRevealState>(() => active ? "warming" : "hidden");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const termRef = useRef<any>(null);
  const addonsRef = useRef<TerminalAddons | null>(null);
  const helperTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const paneRuntimeRef = useRef<LegacyTerminalRuntimePaneRuntimePort | null>(null);
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  const initialCommandRef = useRef(initialCommand);
  initialCommandRef.current = initialCommand;
  const agentCommandRef = useRef(agentCommand);
  agentCommandRef.current = agentCommand;
  const terminalThemeRef = useRef(terminalTheme);
  terminalThemeRef.current = terminalTheme;
  const allowTransparencyRef = useRef(allowTransparency);
  allowTransparencyRef.current = allowTransparency;
  const locationRef = useRef(location);
  locationRef.current = location;
  const onTerminalCustomKeyRef = useRef(onTerminalCustomKey);
  onTerminalCustomKeyRef.current = onTerminalCustomKey;
  const shiftEnterNewlineRef = useRef(shiftEnterNewline);
  shiftEnterNewlineRef.current = shiftEnterNewline;
  const sessionStarterRef = useRef(sessionStarter);
  sessionStarterRef.current = sessionStarter;
  const sessionResizerRef = useRef(sessionResizer);
  sessionResizerRef.current = sessionResizer;
  const sessionWriterRef = useRef(sessionWriter);
  sessionWriterRef.current = sessionWriter;
  const revealPolicyRef = useRef(revealPolicy);
  revealPolicyRef.current = revealPolicy;
  const suggestionAdapterRef = useRef(suggestionAdapter);
  suggestionAdapterRef.current = suggestionAdapter;
  const linkContextAdapterRef = useRef(linkContextAdapter);
  linkContextAdapterRef.current = linkContextAdapter;
  const hiddenOutputBufferFactoryRef = useRef(hiddenOutputBufferFactory);
  hiddenOutputBufferFactoryRef.current = hiddenOutputBufferFactory;
  const rendererFactoryRef = useRef(rendererFactory);
  rendererFactoryRef.current = rendererFactory;
  const rendererEventAdapterRef = useRef(rendererEventAdapter);
  rendererEventAdapterRef.current = rendererEventAdapter;
  const inputEventProcessorRef = useRef(inputEventProcessor);
  inputEventProcessorRef.current = inputEventProcessor;
  const outputEventProcessorRef = useRef(outputEventProcessor);
  outputEventProcessorRef.current = outputEventProcessor;
  const geometryEventAdapterRef = useRef(geometryEventAdapter);
  geometryEventAdapterRef.current = geometryEventAdapter;
  const paneRuntimeFactoryRef = useRef(paneRuntimeFactory);
  paneRuntimeFactoryRef.current = paneRuntimeFactory;
  const writeSchedulerFactoryRef = useRef(writeSchedulerFactory);
  writeSchedulerFactoryRef.current = writeSchedulerFactory;
  const onRendererHandlesReadyRef = useRef(onRendererHandlesReady);
  onRendererHandlesReadyRef.current = onRendererHandlesReady;
  const activeRef = useRef(active);
  activeRef.current = active;
  const renderAccelerationEligibleRef = useRef(renderAccelerationEligible);
  renderAccelerationEligibleRef.current = renderAccelerationEligible;

  const resizeRuntimeSession = (targetPaneId: string, cols: number, rows: number) => {
    const resizer = sessionResizerRef.current;
    if (resizer) {
      resizer.resize(targetPaneId, cols, rows);
      return;
    }
    resizeTerminalSession(targetPaneId, cols, rows);
  };
  const writeRuntimeSession: typeof writeTerminalSession = (targetPaneId, data, metadata) => {
    const writer = sessionWriterRef.current;
    if (writer) {
      writer.write(targetPaneId, data, metadata);
      return;
    }
    writeTerminalSession(targetPaneId, data, metadata);
  };
  const notifySuggestionRemainderChange = (remainder: string) => {
    const adapter = suggestionAdapterRef.current;
    if (adapter) {
      adapter.remainderChanged(remainder);
      return;
    }
    onSuggestionRemainderChangeRef.current?.(remainder);
  };
  const notifySuggestionLayoutChange = () => {
    const adapter = suggestionAdapterRef.current;
    if (adapter) {
      adapter.layoutChanged();
      return;
    }
    onSuggestionLayoutChangeRef.current?.();
  };
  const openLinkContextMenu = (payload: TerminalLinkContextMenuPayload, containerRect: DOMRect | null) => {
    const adapter = linkContextAdapterRef.current;
    if (adapter) {
      adapter.openContextMenu(payload, containerRect);
      return;
    }
    onLinkContextMenuRef.current?.({
      ...payload,
      clientX: containerRect ? payload.clientX - containerRect.left : payload.clientX,
      clientY: containerRect ? payload.clientY - containerRect.top : payload.clientY,
    });
  };

  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onRuntimeSessionIdChangeRef = useRef(onRuntimeSessionIdChange);
  onRuntimeSessionIdChangeRef.current = onRuntimeSessionIdChange;
  const onRuntimeStatusChangeRef = useRef(onRuntimeStatusChange);
  onRuntimeStatusChangeRef.current = onRuntimeStatusChange;
  const historyRef = useRef(history);
  historyRef.current = history;
  const onInlineCommandSubmitRef = useRef(onInlineCommandSubmit);
  onInlineCommandSubmitRef.current = onInlineCommandSubmit;
  const onSearchReadyRef = useRef(onSearchReady);
  onSearchReadyRef.current = onSearchReady;
  const onSuggestionRemainderChangeRef = useRef(onSuggestionRemainderChange);
  onSuggestionRemainderChangeRef.current = onSuggestionRemainderChange;
  const onSuggestionLayoutChangeRef = useRef(onSuggestionLayoutChange);
  onSuggestionLayoutChangeRef.current = onSuggestionLayoutChange;
  const onLinkContextMenuRef = useRef(onLinkContextMenu);
  onLinkContextMenuRef.current = onLinkContextMenu;
  const onCurrentDirectoryChangeRef = useRef(onCurrentDirectoryChange);
  onCurrentDirectoryChangeRef.current = onCurrentDirectoryChange;

  const write = useCallback((data: string) => {
    writeRuntimeSession(paneId, data);
  }, [paneId]);

  const focus = useCallback(() => {
    termRef.current?.focus?.();
  }, []);

  const revealGenerationRef = useRef(0);
  const revealSettleFrameRef = useRef<number | null>(null);
  const hasRenderedOnceRef = useRef(false);

  const cancelTerminalRevealSettle = useCallback(() => {
    if (revealSettleFrameRef.current === null) return;
    cancelAnimationFrame(revealSettleFrameRef.current);
    revealSettleFrameRef.current = null;
  }, []);

  const settleTerminalReveal = useCallback((generation = revealGenerationRef.current) => {
    if (!activeRef.current) return;
    if (generation !== revealGenerationRef.current) return;
    hasRenderedOnceRef.current = true;
    setRevealState("settled");
    cancelTerminalRevealSettle();
  }, [cancelTerminalRevealSettle]);

  const scheduleTerminalRevealFallback = useCallback((generation = revealGenerationRef.current) => {
    cancelTerminalRevealSettle();
    revealSettleFrameRef.current = requestAnimationFrame(() => {
      revealSettleFrameRef.current = requestAnimationFrame(() => {
        revealSettleFrameRef.current = null;
        settleTerminalReveal(generation);
      });
    });
  }, [cancelTerminalRevealSettle, settleTerminalReveal]);

  const fit = useCallback(() => {
    if (!activeRef.current) return;
    addonsRef.current?.fitAddon.fit();
    const term = termRef.current;
    if (term) {
      resizeRuntimeSession(paneId, term.cols, term.rows);
    }
    notifySuggestionLayoutChange();
  }, [paneId]);

  const fitViewport = useCallback(() => {
    if (!activeRef.current) return;
    addonsRef.current?.fitAddon.fit();
    notifySuggestionLayoutChange();
  }, []);

  const activateWebglForActiveTerminal = useCallback(async () => {
    const term = termRef.current;
    const addons = addonsRef.current;
    const runtime = paneRuntimeRef.current;
    if (!activeRef.current || !term || !addons || addons.webglAddon || !runtime) {
      return;
    }
    if (runtime.getSnapshot().renderer !== "canvas") {
      return; // already promoting or promoted
    }

    runtime.notifyRendererPromoting();
    if (runtime.getSnapshot().renderer !== "webgl_pending") {
      return;
    }
    try {
      const snapshot = runtime.getSnapshot();
      if (snapshot.liveResizeActive) {
        runtime.notifyRendererPromotionFailed();
        return;
      }

      const webgl = await activateWebglRenderer(term, {
        activePaneEligible: renderAccelerationEligibleRef.current,
        // The `stillCurrent` check below runs only AFTER this call resolves, by which point the
        // addon has already been loaded onto `term`. If the pane was torn down while the
        // activator's dynamic import was in flight, that load throws from inside the addon
        // (disposed xterm hands out an undefined linkifier). So the staleness test has to go in.
        isStale: () => termRef.current !== term || addonsRef.current !== addons,
        onLost: () => {
          // Context-loss recovery: addon is already disposed by the callback
          // contract. Clear our stored reference so future activation attempts
          // can re-run, and notify the runtime so the state machine fires a
          // forced repaint on the fallback renderer.
          if (addonsRef.current) {
            addonsRef.current.webglAddon = null;
          }
          paneRuntimeRef.current?.notifyRendererLost();
        },
      });
      const stillCurrent = activeRef.current
        && termRef.current === term
        && addonsRef.current === addons
        && runtime.getSnapshot().renderer === "webgl_pending"
        && !runtime.getSnapshot().liveResizeActive;
      if (stillCurrent && webgl) {
        addons.webglAddon = webgl;
        // Runtime entry-action on promotion fires refreshViewport for us when
        // the cell is in ready_visible — no need for an inline rAF refresh.
        runtime.notifyRendererPromoted();
      } else {
        webgl?.dispose();
        runtime.notifyRendererPromotionFailed();
      }
    } catch (err) {
      runtime.notifyRendererPromotionFailed();
      throw err;
    }
  }, []);

  const demoteWebglRenderer = useCallback(() => {
    const addons = addonsRef.current;
    const runtime = paneRuntimeRef.current;
    const addon = addons?.webglAddon;
    if (addon) {
      addon.dispose();
      if (addonsRef.current === addons) {
        addons.webglAddon = null;
      }
    }
    runtime?.notifyRendererDemoted();
  }, []);

  useEffect(() => {
    if (!active) {
      // Bound live GPU contexts: only the active workspace's panes may hold a
      // WebGL canvas (matters under the `smooth-active-pane`/`force` policies;
      // default `auto` disables WebGL inside Tauri entirely). The swap back to
      // the DOM renderer shows identical content because the background drain
      // keeps the hidden pane's buffer current.
      demoteWebglRenderer();
      return;
    }
    if (shouldDemoteTerminalWebglForEligibility({ activePaneEligible: renderAccelerationEligible })) {
      demoteWebglRenderer();
      return;
    }
    if (renderAccelerationEligible) {
      void activateWebglForActiveTerminal();
    }
  }, [active, activateWebglForActiveTerminal, demoteWebglRenderer, renderAccelerationEligible]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.allowTransparency = allowTransparency;
  }, [allowTransparency]);

  useEffect(() => {
    if (!termRef.current || !terminalTheme) return;
    termRef.current.options.theme = terminalTheme;
  }, [terminalTheme]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    if (!activeRef.current) return;
    // A font-size change resizes the glyph cell, which changes the cols/rows
    // for the same container box. fit() updates xterm's grid; without an
    // immediate SIGWINCH the shell keeps printing at the old width, producing
    // misaligned prompts. A refresh forces the renderer to repaint at the
    // new dimensions in case WebGL didn't auto-invalidate.
    addonsRef.current?.fitAddon.fit();
    resizeRuntimeSession(paneId, term.cols, term.rows);
    term.refresh?.(0, term.rows - 1);
  }, [fontSize, paneId]);

  useEffect(() => {
    return subscribeTerminalSessionStatus(paneId, (status) => {
      onRuntimeStatusChangeRef.current?.(status);
    });
  }, [paneId]);

  useEffect(() => {
    return subscribeTerminalActivity(paneId, (activity) => {
      rendererPool.updateSignals(paneId, { agentActive: activity === "running" });
    });
  }, [paneId]);

  useBrowserLayoutEffect(() => {
    // Workspace switches reveal the already-mounted xterm DOM in the same
    // React commit. Apply visibility, drain/refresh, and sync the terminal
    // geometry before the browser gets a chance to paint the newly-active
    // workspace; otherwise users can see one stale-background frame.
    paneRuntimeRef.current?.setVisible(active);
    rendererPool.updateSignals(paneId, { isVisible: active });
    const term = termRef.current;
    const decision = (revealPolicyRef.current ?? DEFAULT_REVEAL_POLICY).resolve({
      active,
      hasTerminal: Boolean(term),
      hasRenderedOnce: hasRenderedOnceRef.current,
      currentGeneration: revealGenerationRef.current,
    });
    revealGenerationRef.current = decision.generation;
    if (decision.cancelSettle) cancelTerminalRevealSettle();
    setRevealState(decision.revealState);
    if (decision.scheduleFallback) scheduleTerminalRevealFallback(decision.generation);
    if (!active || !term) return;

    addonsRef.current?.fitAddon.fit();
    resizeRuntimeSession(paneId, term.cols, term.rows);
    term.refresh?.(0, term.rows - 1);
  }, [active, cancelTerminalRevealSettle, paneId, scheduleTerminalRevealFallback]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      void activateWebglForActiveTerminal();
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [active, activateWebglForActiveTerminal]);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    let roCleanup: (() => void) | undefined;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    let geometryRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let cmdTimer: ReturnType<typeof setTimeout> | undefined;
    let trustTimer: ReturnType<typeof setTimeout> | undefined;
    let outputResizeTimer: ReturnType<typeof setTimeout> | undefined;
    let bufferCheckTimer: ReturnType<typeof setTimeout> | null = null;
    let rendererHandlesCleanup: void | (() => void);
    let rendererEventSubscription: { dispose(): void } | undefined;
    let rendererDispose: (() => void) | null = null;
    let suggestionLayoutRaf: number | null = null;
    let fitRaf: number | null = null;

    let inlineInput = "";
    let activeSuggestionRemainder = "";
    const hiddenOutputBuffer = hiddenOutputBufferFactoryRef.current?.()
      ?? new TerminalDormantRing({ maxBlocks: DORMANT_RING_MAX_BLOCKS });
    // Char-cell snap memo. Updated after every successful fit so the resize
    // hot path can short-circuit when the proposed cols/rows match — the
    // expensive xterm reflow + WebGL buffer realloc happen INSIDE fit(),
    // so skipping the call is the actual saving.
    let lastFittedCols: number | null = null;
    let lastFittedRows: number | null = null;
    // Assigned once syncPtySize + addons + term are available in the import
    // .then() block below. The state machine's commitFit host method routes
    // here for an immediate, debounce-bypassing fit + SIGWINCH on drag end.
    let commitFitFn: (() => void) | null = null;

    const writeSchedulerFactory = writeSchedulerFactoryRef.current
      ?? ((request: { paneId: string; write: TerminalWriteFn; refresh: () => void }) => createTerminalWriteScheduler({
        // 2MB cap: if a burst exceeds this before xterm drains it, subsequent
        // pushes are dropped with a visible notice rather than OOM-ing the tab.
        maxPendingBytes: 2 * 1024 * 1024,
        metrics: createTerminalWriteMetricsObserver(request.paneId),
        write: request.write,
        refresh: request.refresh,
      }));
    const outputScheduler = writeSchedulerFactory({
      paneId,
      write: (data, callback) => {
        const term = termRef.current;
        if (!term) {
          callback();
          return;
        }
        term.write(data, callback);
      },
      refresh: () => {
        const term = termRef.current;
        if (term && activeRef.current) term.refresh?.(0, term.rows - 1);
      },
    });

    // Background drain: while the pane is hidden we still feed buffered output
    // into xterm on a coarse timer instead of stockpiling it until reveal.
    // Parsing into xterm's buffer is cheap while `visibility:hidden` suppresses
    // paint, and it keeps the buffer current so a workspace switch reveals
    // up-to-date content in the very first frame — no post-reveal "pop" while
    // a large drain parses asynchronously. The ring only accumulates for real
    // when no terminal instance exists (pre-init or pool-evicted).
    const HIDDEN_DRAIN_INTERVAL_MS = 120;
    let hiddenDrainTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleHiddenDrain() {
      if (hiddenDrainTimer !== null) return;
      hiddenDrainTimer = setTimeout(() => {
        hiddenDrainTimer = null;
        if (disposed || !termRef.current) return;
        if (paneRuntime.getSnapshot().state !== "ready_hidden") return;
        hiddenOutputBuffer.drain((chunk) => outputScheduler.push(chunk));
        outputScheduler.flush();
      }, HIDDEN_DRAIN_INTERVAL_MS);
    }

    function appendHiddenOutput(data: string) {
      hiddenOutputBuffer.append(data);
      if (termRef.current) scheduleHiddenDrain();
    }

    const paneHost: TerminalPaneHost = {
      drainHiddenBuffer: (write) => hiddenOutputBuffer.drain(write),
      writeToTerminal: (data) => {
        if (!termRef.current) return;
        outputScheduler.push(data);
        outputScheduler.flush();
      },
      refreshViewport: () => {
        const term = termRef.current;
        if (term && activeRef.current) term.refresh?.(0, term.rows - 1);
      },
      disposeTerminal: () => {
        outputScheduler.dispose();
      },
      commitFit: () => {
        commitFitFn?.();
      },
    };
    const createPaneRuntime = paneRuntimeFactoryRef.current
      ?? ((request: { host: TerminalPaneHost; initiallyVisible: boolean }) => new TerminalPaneRuntime(request.host, { initiallyVisible: request.initiallyVisible }));
    const paneRuntime = createPaneRuntime({ host: paneHost, initiallyVisible: activeRef.current });
    paneRuntimeRef.current = paneRuntime;
    paneRuntime.init();

    // Drag bus: while the user drags a workspace pane border, gate the
    // dragged cell's expensive fit() / SIGWINCH work. On commit, the runtime
    // routes back through `paneHost.commitFit` for a single authoritative
    // pass at the final geometry.
    const unsubscribeLiveResize = subscribeLegacyTerminalGridLiveResize((detail) => {
      if (detail.phase === "live") {
        demoteWebglRenderer();
        paneRuntime.notifyLiveResizeStart();
      } else {
        paneRuntime.notifyLiveResizeEnd();
      }
    });

    function scheduleSuggestionLayoutChange() {
      if (suggestionLayoutRaf !== null) return;
      suggestionLayoutRaf = requestAnimationFrame(() => {
        suggestionLayoutRaf = null;
        notifySuggestionLayoutChange();
      });
    }

    void (async () => {
      if (disposed || !containerRef.current) return;
      const createRenderer = rendererFactoryRef.current;
      let renderer: LegacyTerminalRuntimeRenderer;
      if (createRenderer) {
        renderer = await createRenderer({
          container: containerRef.current,
          cwd,
          fontSize: fontSizeRef.current,
          terminalTheme: terminalThemeRef.current,
          allowTransparency: allowTransparencyRef.current,
          isDisposed: () => disposed,
          onLinkContextMenu: (payload) => {
            const rect = containerRef.current?.getBoundingClientRect() ?? null;
            openLinkContextMenu(payload, rect);
          },
        });
      } else {
        const { Terminal } = await import("@xterm/xterm");
        await waitForTerminalFonts();
        if (disposed || !containerRef.current) return;

        // Read the CSS variable so xterm's initial background matches the active
        // theme exactly. The hardcoded fallback (`#060609`) is only used when the
        // DOM is unavailable (SSR / test environments) — in all live renders the
        // CSS variable is set by ThemeContext before the terminal mounts, so the
        // canvas paints the correct colour on the very first frame.
        const cssBg = typeof document !== "undefined"
          ? (getComputedStyle(document.documentElement).getPropertyValue("--cs-terminal-bg").trim() || "#060609")
          : "#060609";
        const initialTheme = terminalThemeRef.current ?? {
          background: cssBg,
          foreground: "#e8e8f0",
          cursor: "#7c3aed",
          cursorAccent: cssBg,
          selectionBackground: "rgba(124, 58, 237, 0.3)",
          black: "#1a1a28",
          brightBlack: "#3a3a4a",
          red: "#f87171",
          brightRed: "#fca5a5",
          green: "#34d399",
          brightGreen: "#6ee7b7",
          yellow: "#fbbf24",
          brightYellow: "#fcd34d",
          blue: "#60a5fa",
          brightBlue: "#93c5fd",
          magenta: "#c084fc",
          brightMagenta: "#d8b4fe",
          cyan: "#22d3ee",
          brightCyan: "#67e8f9",
          white: "#e8e8f0",
          brightWhite: "#f8f8ff",
        };

        const renderMetrics = resolveCodeSpaceTerminalRenderMetrics();
        const term = new Terminal({
          theme: initialTheme,
          fontFamily: detectMonoFontFamily(),
          fontSize: fontSizeRef.current,
          lineHeight: renderMetrics.lineHeight,
          letterSpacing: renderMetrics.letterSpacing,
          fontWeight: renderMetrics.fontWeight,
          fontWeightBold: renderMetrics.fontWeightBold,
          customGlyphs: true,
          cursorBlink: true,
          cursorStyle: "bar",
          cursorInactiveStyle: "outline",
          allowProposedApi: true,
          linkHandler: terminalOscLinkHandler,
          allowTransparency: allowTransparencyRef.current,
          rescaleOverlappingGlyphs: false,
          scrollback: 5000,
        });

        term.open(containerRef.current);
        const addons = await loadTerminalAddons(term, () => disposed, {
          cwd,
          onLinkContextMenu: (payload) => {
            const rect = containerRef.current?.getBoundingClientRect() ?? null;
            openLinkContextMenu(payload, rect);
          },
        });
        renderer = {
          terminal: term,
          addons,
          helperTextarea: containerRef.current.querySelector("textarea.xterm-helper-textarea"),
          dispose: () => {
            addons.dispose();
            term.dispose();
          },
        };
      }
      const term = renderer.terminal;
      const addons = renderer.addons;
      rendererDispose = renderer.dispose;
      termRef.current = term;
      if (activeRef.current && !hasRenderedOnceRef.current) {
        setRevealState((current) => current === "settled" ? current : "warming");
        scheduleTerminalRevealFallback(revealGenerationRef.current);
      }
      paneRuntime.notifyXtermCreated();

      // Authoritative agent-standby detection via xterm's rendered buffer.
      // onWriteParsed fires after xterm applies all cursor movements and updates
      // its buffer — read the actual last rows rather than parsing the raw stream
      // (which collapses cursor-movement codes and makes line detection unreliable).
      const scheduleAgentStandbyBufferCheck = () => {
        if (bufferCheckTimer) clearTimeout(bufferCheckTimer);
        bufferCheckTimer = setTimeout(() => {
          bufferCheckTimer = null;
          const t = termRef.current;
          if (!t) return;
          const buf = t.buffer?.active;
          if (!buf) return;
          const lastRow = buf.baseY + t.rows - 1;
          // Read the window once, bottom rows first, then decide. Reading the ready footer and
          // acting on it immediately is what made a working agent look finished: Claude Code
          // keeps that footer on screen for the whole turn, with its spinner a few rows above.
          // A visible working line therefore has to veto the standby, so the window has to be
          // wide enough to hold both and be inspected as a whole.
          const rows: string[] = [];
          for (let row = lastRow; row >= Math.max(0, lastRow - 7); row--) {
            rows.push(buf.getLine(row)?.translateToString(true) ?? "");
          }
          if (rows.some(isWorkingStatusLine)) return;
          if (rows.slice(0, 4).some(isAgentReadyLine)) {
            noteTerminalAgentStandby(paneId);
          }
        }, 80);
      };
      scheduleAgentStandbyBufferCheck();
      helperTextareaRef.current = renderer.helperTextarea;

      if (disposed) {
        rendererDispose?.();
        rendererDispose = null;
        return;
      }
      addonsRef.current = addons;
      rendererHandlesCleanup = onRendererHandlesReadyRef.current?.({
        terminal: term,
        fitAddon: addons.fitAddon,
      });

      // Register with the renderer pool. If we're past MAX_POOL_SLOTS the pool
      // evicts the lowest-scored pane (serialize → dispose → onEvict). The
      // evict callback nulls termRef/addonsRef so subsequent output routes to
      // DormantRing via the existing ready_hidden guard in handleRuntimeOutput.
      rendererPool.register(paneId, term, addons, () => {
        if (termRef.current !== term) return; // already disposed by cleanup
        // Null refs first so handleRuntimeOutput routes new output to DormantRing
        // via the ready_hidden guard — no further writes to the disposed terminal.
        termRef.current = null;
        addonsRef.current = null;
        const disposeRenderer = rendererDispose;
        rendererDispose = null;
        if (disposeRenderer) {
          disposeRenderer();
        } else {
          term.dispose();
          addons.dispose();
        }
        // The pool stores the snapshot under paneId; claimSnapshot retrieves it
        // when this pane next creates a fresh terminal (rehydration).
      });

      // Rehydrate terminal state from a prior eviction snapshot.
      const snapshot = rendererPool.claimSnapshot(paneId);
      if (snapshot) {
        term.write(snapshot);
      }

      if (addons.searchAddon && onSearchReadyRef.current) {
        onSearchReadyRef.current({
          findNext: (query: string, mode: TerminalSearchMode = "navigate") => {
            const matched = addons.searchAddon!.findNext(query, createTerminalSearchOptions(mode));
            if (hasVisibleTerminalSearchSelection(term, query)) {
              repaintTerminalSearchSelection(term, query);
              return matched;
            }
            return selectTerminalSearchFallbackMatch({
              direction: "next",
              includeCurrentSelection: mode === "live",
              query,
              terminal: term,
            }) || matched;
          },
          findPrevious: (query: string) => {
            const matched = addons.searchAddon!.findPrevious(query, createTerminalSearchOptions("navigate"));
            if (hasVisibleTerminalSearchSelection(term, query)) {
              repaintTerminalSearchSelection(term, query);
              return matched;
            }
            return selectTerminalSearchFallbackMatch({ direction: "previous", query, terminal: term }) || matched;
          },
          clearSearch: () => {
            addons.searchAddon!.clearDecorations();
            term.clearSelection?.();
          },
        });
      }

      let trustPromptSeen = false;

      const handleRuntimeOutput = (data: string) => {
        if (disposed) return;

        const processOutputEvent = outputEventProcessorRef.current ?? DEFAULT_OUTPUT_EVENT_PROCESSOR;
        const result = processOutputEvent({
          data,
          paneRuntimeState: paneRuntime.getSnapshot().state,
          trustPromptSeen,
          cwd,
          cwdTrusted: getTrustedTerminalDirs().has(cwd),
          hasActiveSuggestionRemainder: Boolean(activeSuggestionRemainder),
        });
        trustPromptSeen = result.nextTrustPromptSeen;

        if (result.exitCode !== null) {
          markTerminalSessionExited(paneId);
          resetTerminalActivity(paneId);
          onRuntimeSessionIdChangeRef.current?.(null);
          onExitRef.current?.(result.exitCode);
          return;
        }

        for (const nextCwd of result.cwdUpdates) {
          onCurrentDirectoryChangeRef.current?.(nextCwd);
        }
        for (const event of result.osc133Events) {
          noteTerminalCommandBoundary(paneId, event);
        }
        if (result.visibleData) {
          noteTerminalOutputChunk(paneId, result.visibleData);
        }
        const autoTrustResponse = result.autoTrustResponse;
        if (autoTrustResponse) {
          trustTimer = setTimeout(() => writeRuntimeSession(paneId, autoTrustResponse), 80);
        }
        if (result.rememberTrustedCwd) {
          rememberTrustedTerminalDir(cwd);
        }
        if (result.resizeAfterTrust) {
          outputResizeTimer = setTimeout(() => {
            if (termRef.current) {
              resizeRuntimeSession(paneId, termRef.current.cols, termRef.current.rows);
            }
          }, 150);
        }

        if (result.outputRoute === "visible") {
          outputScheduler.push(result.visibleData);
        } else if (result.outputRoute === "hidden") {
          appendHiddenOutput(result.visibleData);
        }
        if (result.scheduleSuggestionLayout) {
          scheduleSuggestionLayoutChange();
        }
      };

      const handleTerminalData = (data: string) => {
        const processInputEvent = inputEventProcessorRef.current ?? DEFAULT_INPUT_EVENT_PROCESSOR;
        const result = processInputEvent({
          currentInput: inlineInput,
          data,
          history: historyRef.current,
          cwd,
          agentCommand: agentCommandRef.current,
        });
        inlineInput = result.nextInput;
        activeSuggestionRemainder = result.suggestionRemainder;
        notifySuggestionRemainderChange(activeSuggestionRemainder);

        if (result.submittedPrompt) {
          onInlineCommandSubmitRef.current?.(result.submittedPrompt);
        }

        if (result.writeRequest) {
          noteTerminalUserInput(paneId, {
            agentTurnCandidate: Boolean(agentCommandRef.current),
            data: result.writeRequest.data,
            submitted: Boolean(result.writeRequest.metadata?.submitted),
          });
          writeRuntimeSession(paneId, result.writeRequest.data, result.writeRequest.metadata);
        }

        scheduleSuggestionLayoutChange();
      };

      const rendererEventAdapter = rendererEventAdapterRef.current;
      if (rendererEventAdapter) {
        rendererEventSubscription = rendererEventAdapter({
          terminal: term,
          handlers: {
            onData: handleTerminalData,
            onRender: () => settleTerminalReveal(),
            onWriteParsed: scheduleAgentStandbyBufferCheck,
            onCustomKey: (event) => handleTerminalCustomKeyEvent(
              event,
              (data) => writeRuntimeSession(paneId, data),
              (customEvent) => onTerminalCustomKeyRef.current?.(customEvent),
              { shiftEnterSequence: () => shiftEnterNewlineRef.current?.() ?? null },
            ),
          },
          onDisposeError: (error, source) => {
            console.warn(`[terminal] Failed to dispose renderer event subscription (${source})`, error);
          },
        });
      } else {
        const dataDisposable = term.onData?.(handleTerminalData);
        const renderDisposable = term.onRender?.(() => settleTerminalReveal());
        const writeParsedDisposable = term.onWriteParsed?.(scheduleAgentStandbyBufferCheck);
        term.attachCustomKeyEventHandler?.((event: KeyboardEvent) =>
          handleTerminalCustomKeyEvent(
            event,
            (data) => writeRuntimeSession(paneId, data),
            (customEvent) => onTerminalCustomKeyRef.current?.(customEvent),
            { shiftEnterSequence: () => shiftEnterNewlineRef.current?.() ?? null },
          ),
        );
        rendererEventSubscription = {
          dispose: () => {
            dataDisposable?.dispose?.();
            renderDisposable?.dispose?.();
            writeParsedDisposable?.dispose?.();
          },
        };
      }

      // Guard: track last cols/rows sent to PTY to skip no-op SIGWINCH.
      let lastSentCols = term.cols;
      let lastSentRows = term.rows;
      // Guard: track last observed container dimensions to skip fit() when
      // ResizeObserver fires without an actual size change (layout shift, etc.).
      let lastObservedSize: TerminalObservedSize | null = null;

      const isRuntimeStarted = () => {
        const s = paneRuntime.getSnapshot().state;
        return s === "ready_hidden" || s === "ready_visible";
      };

      const measureGeometry = () => measureTerminalGeometry({
        container: containerRef.current,
        fitAddon: addons.fitAddon,
        term,
      });

      const startRuntimeSession = (geometry: TerminalGeometry) => {
        if (disposed || isRuntimeStarted()) return false;

        lastSentCols = geometry.cols;
        lastSentRows = geometry.rows;

        // Runtime transitions to ready_hidden | ready_visible based on
        // visibility intent — entry action for ready_visible drains the
        // hidden buffer and refreshes the viewport. No manual drain call
        // needed here; it's the state machine's job now.
        paneRuntime.notifyAttached();

        const scheduleStartupCommand = (created: boolean) => {
          // Skip the typed-command path when the binary was launched directly via
          // terminalCommand — the process is already running, no shell prompt to wait for.
          if (!created) return;
          if (initialCommandRef.current && !terminalCommand?.length) {
            seedPanePrompt(paneId, initialCommandRef.current);
            cmdTimer = setTimeout(() => {
              writeRuntimeSession(paneId, initialCommandRef.current + "\r");
            }, 500);
          } else if (terminalCommand?.length) {
            seedPanePrompt(paneId, terminalCommand.join(" "));
          }
        };

        const handleConnectFailure = (err: unknown) => {
          if (disposed) return;
          console.error("[terminal] PTY connection failed:", err);
          // Write a styled error into the xterm buffer and arm an
          // Enter-to-retry handler (Terax spawn-failure UX).
          const errMsg = err instanceof Error ? err.message : String(err);
          term.write(
            `\r\n\x1b[31m[PTY connect failed]\x1b[0m \x1b[2m${errMsg}\x1b[0m\r\n` +
            `\r\n\x1b[2mPress Enter to retry...\x1b[0m\r\n`,
          );
          const retryDisposable = term.onKey(({ key }: { key: string }) => {
            if (key === "\r") {
              retryDisposable.dispose();
              if (!disposed) tryStartRuntimeSession();
            }
          });
        };

        const sessionStarter = sessionStarterRef.current;
        if (sessionStarter) {
          sessionStarter.start({
            paneId,
            workspaceId,
            cwd,
            geometry: { cols: geometry.cols, rows: geometry.rows },
            onOutput: handleRuntimeOutput,
            command: terminalCommand,
            provider: providerFromAgentCommand(agentCommandRef.current),
            claudeAccount,
            location: locationRef.current,
            canvasTerminalId,
          })
            .then((outcome) => {
              if (disposed) return;
              onRuntimeSessionIdChangeRef.current?.(outcome.sessionId);
              scheduleStartupCommand(outcome.kind === "created");
            })
            .catch(handleConnectFailure);
        } else {
          const reattached = attachTerminalSession(paneId, handleRuntimeOutput, { workspaceId, cwd });
          if (reattached) {
            resizeRuntimeSession(paneId, geometry.cols, geometry.rows);
            // Repaint the fresh xterm from the pane's rolling transcript — without
            // this a project switch A→B→A leaves an empty, transparent terminal
            // (the PTY survives but the disposed xterm buffer was never restored).
            // The grid was already sized by measureGeometry()'s fit() above, so
            // fit→resizePty→write ordering holds and scrolling output lands square.
            // Pushed raw through the scheduler (NOT handleRuntimeOutput) so replay
            // does not re-fire cwd/OSC133/auto-trust detection on historical bytes.
            const transcript = peekTerminalTranscript(paneId);
            if (transcript) {
              outputScheduler.push(transcript);
              outputScheduler.flush();
            }
            onRuntimeSessionIdChangeRef.current?.(getTerminalRuntimeSessionId(paneId));
          }

          const runtimeSession = reattached
            ? null
            : createTerminalSession({
                paneId,
                workspaceId,
                cwd,
                cols: geometry.cols,
                rows: geometry.rows,
                onOutput: handleRuntimeOutput,
                command: terminalCommand,
                provider: providerFromAgentCommand(agentCommandRef.current),
                claudeAccount,
                location: locationRef.current,
                canvasTerminalId,
              });

          runtimeSession?.connectPromise
            .then(() => {
              if (!disposed) {
                onRuntimeSessionIdChangeRef.current?.(getTerminalRuntimeSessionId(paneId));
              }
            })
            .catch(handleConnectFailure);

          scheduleStartupCommand(!reattached);
        }

        // WebGL MUST be activated after a valid fit() so the GPU buffer
        // allocates at the correct canvas dimensions.
        void activateWebglForActiveTerminal();

        return true;
      };

      const tryStartRuntimeSession = () => {
        const geometry = measureGeometry();
        const decision = (geometryEventAdapterRef.current ?? DEFAULT_GEOMETRY_EVENT_ADAPTER)
          .resolveInitialGeometryEvent(geometry);
        return decision.kind === "start-session" ? startRuntimeSession(decision.geometry) : false;
      };

      const sendPtySize = () => {
        const cols = term.cols;
        const rows = term.rows;
        if (cols === lastSentCols && rows === lastSentRows) return;
        lastSentCols = cols;
        lastSentRows = rows;
        resizeRuntimeSession(paneId, cols, rows);
      };

      // Inline trailing-edge debounce that exposes its pending timer so the
      // drag-commit path can flush + cancel deterministically. `debounce()`
      // from lib/utils doesn't return a cancel handle.
      let pendingPtySyncTimer: ReturnType<typeof setTimeout> | null = null;
      const syncPtySize = () => {
        if (pendingPtySyncTimer !== null) clearTimeout(pendingPtySyncTimer);
        // 256ms PTY debounce (Terax): coalesces rapid resize events so the
        // shell receives at most one SIGWINCH per resize gesture.  The visual
        // fit has already happened in the rAF above, so this only gates the
        // IPC round-trip that sends cols/rows to the Rust PTY.
        pendingPtySyncTimer = setTimeout(() => {
          pendingPtySyncTimer = null;
          sendPtySize();
        }, 256);
      };
      const cancelPendingPtySync = () => {
        if (pendingPtySyncTimer === null) return;
        clearTimeout(pendingPtySyncTimer);
        pendingPtySyncTimer = null;
      };

      // The xterm-addon-fit type doesn't expose proposeDimensions widely;
      // type it inline so we can probe without a global cast.
      type FitProposer = { proposeDimensions?: () => { cols: number; rows: number } | undefined };

      const performFit = () => {
        addons.fitAddon.fit();
        lastFittedCols = Number.isFinite(term.cols) ? term.cols : lastFittedCols;
        lastFittedRows = Number.isFinite(term.rows) ? term.rows : lastFittedRows;
      };

      // Authoritative drag-commit path. Runs once when the user releases a
      // pane handle. Bypasses the 80ms PTY debounce so the shell learns the
      // new size in the same frame as the visual snap.
      commitFitFn = () => {
        const decision = (geometryEventAdapterRef.current ?? DEFAULT_GEOMETRY_EVENT_ADAPTER)
          .resolveCommitFitEvent({ active: activeRef.current });
        if (decision.kind !== "fit-and-flush") return;
        if (fitRaf !== null) {
          cancelAnimationFrame(fitRaf);
          fitRaf = null;
        }
        performFit();
        cancelPendingPtySync();
        sendPtySize();
        if (activeSuggestionRemainder) {
          scheduleSuggestionLayoutChange();
        }
      };

      const sendResize = () => {
        if (fitRaf !== null) cancelAnimationFrame(fitRaf);
        fitRaf = requestAnimationFrame(() => {
          fitRaf = null;
          // Char-cell snap: ask fit-addon what dimensions it WOULD produce
          // (pure compute, no GPU work). Skip the real fit when it matches
          // the last applied geometry.
          const fitProposer = addons.fitAddon as FitProposer;
          const proposal = fitProposer.proposeDimensions?.();
          const decision = (geometryEventAdapterRef.current ?? DEFAULT_GEOMETRY_EVENT_ADAPTER)
            .resolveResizeEvent({
              active: activeRef.current,
              liveResizeActive: paneRuntime.isLiveResizing(),
              lastFittedCols,
              lastFittedRows,
              proposedCols: proposal?.cols,
              proposedRows: proposal?.rows,
            });
          if (decision.kind !== "fit") return;
          performFit();
          syncPtySize();
          if (activeSuggestionRemainder) {
            scheduleSuggestionLayoutChange();
          }
        });
      };

      const ro = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const { width, height } = entry.contentRect;
        const nextObservedSize = { width, height };
        if (!hasTerminalObservedSizeChanged(lastObservedSize, nextObservedSize)) return;
        lastObservedSize = nextObservedSize;
        if (!isRuntimeStarted()) {
          tryStartRuntimeSession();
          return;
        }
        sendResize();
      });
      ro.observe(containerRef.current);
      roCleanup = () => ro.disconnect();

      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (disposed) return;

      tryStartRuntimeSession();

      resizeTimer = setTimeout(() => {
        if (disposed || !termRef.current) return;
        if (!isRuntimeStarted()) {
          tryStartRuntimeSession();
          return;
        }
        if (activeRef.current) {
          const geometry = measureGeometry();
          if (geometry) resizeRuntimeSession(paneId, geometry.cols, geometry.rows);
        }
      }, 60);

      geometryRetryTimer = setTimeout(() => {
        if (!disposed && !isRuntimeStarted()) tryStartRuntimeSession();
      }, 180);
    })();

    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      clearTimeout(geometryRetryTimer);
      clearTimeout(cmdTimer);
      clearTimeout(trustTimer);
      clearTimeout(outputResizeTimer);
      if (bufferCheckTimer) { clearTimeout(bufferCheckTimer); bufferCheckTimer = null; }
      if (hiddenDrainTimer !== null) { clearTimeout(hiddenDrainTimer); hiddenDrainTimer = null; }
      rendererHandlesCleanup?.();
      rendererHandlesCleanup = undefined;
      outputScheduler.dispose();
      if (suggestionLayoutRaf !== null) {
        cancelAnimationFrame(suggestionLayoutRaf);
      }
      if (fitRaf !== null) {
        cancelAnimationFrame(fitRaf);
        fitRaf = null;
      }
      helperTextareaRef.current = null;
      cancelTerminalRevealSettle();
      onRuntimeSessionIdChangeRef.current?.(null);
      notifySuggestionRemainderChange("");
      unsubscribeLiveResize();
      paneRuntime.dispose();
      paneRuntimeRef.current = null;
      rendererEventSubscription?.dispose();
      roCleanup?.();
      rendererPool.unregister(paneId);
      detachTerminalSession(paneId);
      const disposeRenderer = rendererDispose;
      rendererDispose = null;
      if (disposeRenderer) {
        disposeRenderer();
      } else {
        addonsRef.current?.dispose();
        termRef.current?.dispose();
      }
      termRef.current = null;
      addonsRef.current = null;
    };
  }, [
    activateWebglForActiveTerminal,
    cancelTerminalRevealSettle,
    canvasTerminalId,
    cwd,
    demoteWebglRenderer,
    paneId,
    scheduleTerminalRevealFallback,
    settleTerminalReveal,
    claudeAccount,
    terminalCommand,
    workspaceId,
  ]);

  return {
    containerRef,
    helperTextareaRef,
    revealState,
    write,
    focus,
    fit,
    fitViewport,
  };
}


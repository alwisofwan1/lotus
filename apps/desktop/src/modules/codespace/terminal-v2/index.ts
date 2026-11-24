export { closeTerminalV2LayoutPane, createEmptyTerminalV2Layout, createTerminalV2LayoutFromPaneIds, createTerminalV2LayoutWithPane, focusTerminalV2LayoutPane, getTerminalV2LayoutPaneIds, hasTerminalV2LayoutPane, resizeTerminalV2LayoutSplit, sanitizeTerminalV2LayoutTree, splitTerminalV2LayoutPane } from "./layout/terminal-v2-layout-tree";
export type { TerminalV2LayoutDirection, TerminalV2LayoutLeafNode, TerminalV2LayoutNode, TerminalV2LayoutSplitNode, TerminalV2LayoutTree } from "./layout/terminal-v2-layout-tree";
export {
  TerminalV2RuntimeProvider,
  useOptionalTerminalV2Runtime,
  useTerminalV2Runtime,
} from "./runtime/TerminalV2RuntimeProvider";
export { InteractiveTerminalV2 } from "./components/InteractiveTerminalV2";
export { TerminalV2RendererDiagnostics } from "./components/TerminalV2RendererDiagnostics";
export {
  TERMINAL_V2_RENDERER_DIAGNOSTICS_STORAGE_KEY,
  useTerminalV2RendererDiagnostics,
  useTerminalV2RendererDiagnosticsEnabled,
} from "./hooks/useTerminalV2RendererDiagnostics";
export type { UseTerminalV2RendererDiagnosticsOptions } from "./hooks/useTerminalV2RendererDiagnostics";
export {
  resolveTerminalV2SurfacePolicy,
} from "./components/terminal-v2-surface-policy";
export {
  TERMINAL_V2_NATIVE_RUNTIME_STORAGE_KEY,
  resolveTerminalV2NativeRuntimePolicy,
} from "./components/terminal-v2-native-runtime-policy";
export type {
  TerminalV2NativeRuntimePolicy,
  TerminalV2NativeRuntimePolicyInput,
  TerminalV2NativeRuntimeRolloutMode,
} from "./components/terminal-v2-native-runtime-policy";
export {
  mountTerminalV2PooledRendererUiAdapter,
  resolveTerminalV2PooledRendererUiPolicyInput,
} from "./components/terminal-v2-pooled-renderer-ui-adapter";
export type {
  TerminalV2PooledRendererUiAdapterOptions,
  TerminalV2PooledRendererUiAdapterResult,
  TerminalV2PooledRendererUiRuntime,
} from "./components/terminal-v2-pooled-renderer-ui-adapter";
export type {
  TerminalV2SurfaceFallbackReason,
  TerminalV2SurfacePolicy,
  TerminalV2SurfacePolicyInput,
} from "./components/terminal-v2-surface-policy";
export type {
  InteractiveTerminalHandle as InteractiveTerminalV2Handle,
  TerminalSearchAPI as TerminalV2SearchAPI,
} from "./components/InteractiveTerminalV2";
export {
  TERMINAL_V2_POOLED_DOM_RENDERER_STORAGE_KEY,
  resolveTerminalV2PooledDomRendererPolicy,
} from "./rendering/terminal-v2-pooled-dom-renderer-policy";
export type {
  TerminalV2PooledDomRendererPolicy,
  TerminalV2PooledDomRendererPolicyInput,
} from "./rendering/terminal-v2-pooled-dom-renderer-policy";
export {
  createTerminalV2PooledDomSlot,
} from "./rendering/terminal-v2-pooled-dom-slot";
export type {
  TerminalV2PooledDomSlot,
  TerminalV2PooledDomSlotOptions,
  TerminalV2PooledRenderer,
} from "./rendering/terminal-v2-pooled-dom-slot";
export {
  createTerminalV2PooledDomSlotFactory,
} from "./rendering/terminal-v2-pooled-dom-slot-factory";
export type {
  TerminalV2PooledDomSlotFactory,
  TerminalV2PooledDomSlotFactoryOptions,
} from "./rendering/terminal-v2-pooled-dom-slot-factory";
export {
  createTerminalV2ConstructorPooledXtermRendererFactory,
  createTerminalV2PooledXtermRendererFactory,
} from "./rendering/terminal-v2-pooled-xterm-renderer-factory";
export type {
  TerminalV2ConstructorPooledXtermRendererFactoryOptions,
  TerminalV2PooledXtermConstructor,
  TerminalV2PooledXtermFitAddonConstructor,
  TerminalV2PooledXtermFitAddonLike,
  TerminalV2PooledXtermLike,
  TerminalV2PooledXtermRendererFactory,
  TerminalV2PooledXtermRendererFactoryOptions,
  TerminalV2PooledXtermSerializeAddonConstructor,
  TerminalV2PooledXtermSerializeAddonLike,
} from "./rendering/terminal-v2-pooled-xterm-renderer-factory";
export {
  createTerminalV2PooledDomRuntimeHarness,
} from "./rendering/terminal-v2-pooled-dom-runtime-harness";
export type {
  TerminalV2PooledDomRuntimeHarness,
  TerminalV2PooledDomRuntimeHarnessOptions,
} from "./rendering/terminal-v2-pooled-dom-runtime-harness";
export {
  TerminalV2RendererCoordinator,
} from "./rendering/terminal-v2-renderer-coordinator";
export type {
  TerminalV2RendererCoordinatorOptions,
  TerminalV2RendererCoordinatorResult,
  TerminalV2RendererDebugSnapshot,
  TerminalV2RendererLeaseDebug,
} from "./rendering/terminal-v2-renderer-coordinator";
export {
  createTerminalV2LegacyXtermSlot,
} from "./rendering/terminal-v2-legacy-xterm-slot";
export type { TerminalV2LegacyXtermSlotOptions } from "./rendering/terminal-v2-legacy-xterm-slot";
export {
  TerminalV2XtermRendererHost,
} from "./rendering/terminal-v2-xterm-renderer-host";
export type {
  TerminalV2FitAddonLike,
  TerminalV2XtermLike,
  TerminalV2XtermRendererHostOptions,
  TerminalV2XtermRendererSlot,
} from "./rendering/terminal-v2-xterm-renderer-host";
export {
  TerminalV2RendererAdapter,
} from "./rendering/terminal-v2-renderer-adapter";
export type {
  TerminalV2RendererAdapterOptions,
  TerminalV2RendererHost,
  TerminalV2RendererRestoreError,
} from "./rendering/terminal-v2-renderer-adapter";
export {
  TerminalV2RendererRehydrationStore,
} from "./rendering/terminal-v2-renderer-rehydration-store";
export type {
  TerminalV2RendererRehydrationStoreOptions,
} from "./rendering/terminal-v2-renderer-rehydration-store";
export {
  resolveTerminalV2RevealPolicy,
} from "./rendering/terminal-v2-reveal-policy";
export type {
  TerminalV2RevealPolicyDecision,
  TerminalV2RevealPolicyInput,
  TerminalV2RevealState,
} from "./rendering/terminal-v2-reveal-policy";
export {
  TerminalV2RendererPool,
} from "./rendering/terminal-v2-renderer-pool";
export type {
  TerminalV2RendererBindPlan,
  TerminalV2RendererBindRequest,
  TerminalV2RendererEviction,
  TerminalV2RendererLease as TerminalV2RendererPoolLease,
  TerminalV2RendererPoolOptions,
  TerminalV2RendererReleasePlan,
  TerminalV2RendererSignals,
} from "./rendering/terminal-v2-renderer-pool";
export {
  createTerminalV2PtyResizeDebouncer,
  resolveTerminalV2CommitFitEvent,
  resolveTerminalV2InitialGeometryEvent,
  resolveTerminalV2ResizeEvent,
} from "./geometry/terminal-v2-geometry-event-adapter";
export type {
  TerminalV2CommitFitDecision,
  TerminalV2Geometry as TerminalV2MeasuredGeometry,
  TerminalV2InitialGeometryDecision,
  TerminalV2PtyResizeDebouncer,
  TerminalV2PtyResizeDebouncerOptions,
  TerminalV2ResizeEventDecision,
  TerminalV2ResizeEventInput,
} from "./geometry/terminal-v2-geometry-event-adapter";
export {
  processTerminalV2InputEvent,
} from "./input/terminal-v2-input-event-adapter";
export type {
  TerminalV2InputEventRequest,
  TerminalV2InputEventResult,
  TerminalV2InputWriteRequest,
} from "./input/terminal-v2-input-event-adapter";
export {
  processTerminalV2OutputEvent,
} from "./output/terminal-v2-output-event-adapter";
export type {
  TerminalV2OutputEventInput,
  TerminalV2OutputEventResult,
  TerminalV2OutputRoute,
  TerminalV2PaneRuntimeOutputState,
} from "./output/terminal-v2-output-event-adapter";
export {
  createTerminalV2WriteScheduler,
} from "./output/terminal-v2-write-scheduler-adapter";
export type {
  TerminalV2WriteSchedulerFactory,
  TerminalV2WriteSchedulerFactoryOptions,
} from "./output/terminal-v2-write-scheduler-adapter";
export {
  TERMINAL_V2_OUTPUT_OVERFLOW_NOTICE,
  TerminalV2OutputRing,
} from "./output/terminal-v2-output-ring";
export type { TerminalV2OutputRingOptions } from "./output/terminal-v2-output-ring";
export { useTerminalV2LegacyBridgeFallbackRuntime } from "./hooks/useTerminalV2LegacyBridgeFallbackRuntime";
export type { UseTerminalV2LegacyBridgeFallbackRuntimeOptions } from "./hooks/useTerminalV2LegacyBridgeFallbackRuntime";
export { useTerminalV2NativeRuntime } from "./hooks/useTerminalV2NativeRuntime";
export type {
  UseTerminalV2NativeRuntimeOptions,
  UseTerminalV2NativeRuntimeResult,
} from "./hooks/useTerminalV2NativeRuntime";
export { useTerminalV2PaneRuntime } from "./hooks/useTerminalV2PaneRuntime";
export type {
  UseTerminalV2PaneRuntimeOptions,
  UseTerminalV2PaneRuntimeResult,
} from "./hooks/useTerminalV2PaneRuntime";
export { useTerminalV2XtermEvents } from "./hooks/useTerminalV2XtermEvents";
export type {
  TerminalV2XtermEventAdapter,
  UseTerminalV2XtermEventsOptions,
} from "./hooks/useTerminalV2XtermEvents";
export { useTerminalV2XtermRenderer } from "./hooks/useTerminalV2XtermRenderer";
export type {
  TerminalV2XtermRendererFactory,
  UseTerminalV2XtermRendererOptions,
} from "./hooks/useTerminalV2XtermRenderer";
export { createTerminalV2OwnedXtermRenderer } from "./rendering/terminal-v2-owned-xterm-renderer";
export type {
  CreateTerminalV2OwnedXtermRendererOptions,
  TerminalV2OwnedXtermConstructor,
  TerminalV2OwnedXtermRenderer,
  TerminalV2OwnedXtermTerminal,
} from "./rendering/terminal-v2-owned-xterm-renderer";
export { attachTerminalV2XtermEvents } from "./rendering/terminal-v2-xterm-event-adapter";
export type {
  TerminalV2XtermEventAdapterOptions,
  TerminalV2XtermEventDisposable,
  TerminalV2XtermEventHandlers,
  TerminalV2XtermEventTerminal,
} from "./rendering/terminal-v2-xterm-event-adapter";
export { useTerminalV2Session } from "./hooks/useTerminalV2Session";
export type {
  UseTerminalV2SessionOptions,
  UseTerminalV2SessionResult,
} from "./hooks/useTerminalV2Session";
export { useTerminalV2RendererBinding } from "./hooks/useTerminalV2RendererBinding";
export type {
  TerminalV2RendererHandles,
  UseTerminalV2RendererBindingOptions,
  UseTerminalV2RendererBindingResult,
} from "./hooks/useTerminalV2RendererBinding";
export { useTerminalV2Geometry } from "./hooks/useTerminalV2Geometry";
export type {
  TerminalV2SessionResizer,
  UseTerminalV2GeometryOptions,
  UseTerminalV2GeometryResult,
} from "./hooks/useTerminalV2Geometry";
export { useTerminalV2FocusSearch } from "./hooks/useTerminalV2FocusSearch";
export type {
  TerminalV2FocusRendererHandles,
  TerminalV2SearchApi,
  UseTerminalV2FocusSearchOptions,
  UseTerminalV2FocusSearchResult,
} from "./hooks/useTerminalV2FocusSearch";
export { useTerminalV2Input } from "./hooks/useTerminalV2Input";
export type {
  TerminalV2SessionWriter,
  UseTerminalV2InputOptions,
  UseTerminalV2InputResult,
} from "./hooks/useTerminalV2Input";
export { useTerminalV2Suggestions } from "./hooks/useTerminalV2Suggestions";
export type {
  TerminalV2SuggestionAdapter,
  UseTerminalV2SuggestionsOptions,
  UseTerminalV2SuggestionsResult,
} from "./hooks/useTerminalV2Suggestions";
export { useTerminalV2Links } from "./hooks/useTerminalV2Links";
export type {
  TerminalV2LinkContextAdapter,
  UseTerminalV2LinksOptions,
  UseTerminalV2LinksResult,
} from "./hooks/useTerminalV2Links";
export {
  createTerminalV2PaneRuntimeAdapter,
} from "./runtime/terminal-v2-pane-runtime-adapter";
export type {
  TerminalV2PaneRuntimeAdapterOptions,
  TerminalV2PaneRuntimeFactory,
  TerminalV2PaneRuntimeHost,
  TerminalV2PaneRuntimePort,
  TerminalV2PaneRuntimeSnapshot,
} from "./runtime/terminal-v2-pane-runtime-adapter";
export {
  TerminalV2Runtime,
  createTerminalV2Runtime,
} from "./runtime/terminal-v2-runtime";
export {
  TerminalV2SessionStarter,
} from "./runtime/terminal-v2-session-starter";
export type {
  TerminalV2Geometry,
  TerminalV2SessionStartOutcome,
  TerminalV2SessionStartRequest,
  TerminalV2SessionStarterPort,
} from "./runtime/terminal-v2-session-starter";
export {
  TerminalV2SessionManager,
  mapV2StatusToLegacy as mapSessionManagerV2StatusToLegacy,
} from "./runtime/terminal-v2-session-manager";
export type {
  TerminalV2CreateSessionOptions,
  TerminalV2SessionController,
  TerminalV2SessionHandle,
  TerminalV2SessionProvider,
} from "./runtime/terminal-v2-session-manager";
export {
  installTerminalV2LegacySessionAdapter,
} from "./compat/terminal-session-registry-bridge";
export {
  resolveTerminalSessionCreateRoute,
} from "./compat/terminal-session-routing-policy";
export type {
  TerminalSessionCreateRoutingInput,
  TerminalSessionRoutingDecision,
} from "./compat/terminal-session-routing-policy";
export {
  createLegacyTerminalSessionAdapter,
  mapLegacyStatusToV2,
  mapV2StatusToLegacy,
} from "./compat/legacy-terminal-session-adapter";
export type {
  LegacyTerminalSessionAdapter,
  TerminalV2CompatCreateOptions,
  TerminalV2CompatProvider,
  TerminalV2CompatSessionHandle,
  TerminalV2LegacyRuntimePort,
} from "./compat/legacy-terminal-session-adapter";
export type {
  TerminalV2LaunchKind,
  TerminalV2LaunchSpec,
  TerminalV2MetadataSnapshot,
  TerminalV2PaneId,
  TerminalV2PaneMetadata,
  TerminalV2PersistenceMode,
  TerminalV2RendererLease,
  TerminalV2RendererStatus,
  TerminalV2RuntimeSession,
  TerminalV2RuntimeStatus,
  TerminalV2SessionId,
  TerminalV2WorkspaceId,
  TerminalV2WorkspaceMetadata,
} from "./contracts/terminal-types";
export {
  createCodeSpaceTerminalMetadataRepository,
  toTerminalV2MetadataSnapshot,
} from "./session/codespace-terminal-metadata-repository";
export {
  createMemoryTerminalMetadataRepository,
  type TerminalMetadataRepository,
} from "./session/terminal-metadata-repository";

/**
 * Factory's public face. A host (the workspace shell for Code and Chat, the issue panel, Canvas
 * later) imports from here, never from inside the module: what is exported is the contract, the
 * rest may move. The module never imports a host — a host's own behaviour comes in through props.
 */
export {
  factoryNodeId,
  factoryRunView,
  factoryStartInput,
  factoryWorkflowId,
  latestFactoryRun,
} from "./services/factory-run";
export type { FactoryRef, FactoryRunState, FactoryRunView, FactoryStartRequest } from "./services/factory-run";
export { factoryRefLabel } from "./services/factory-run";
export { createTauriFactoryRunClient, useFactoryRun } from "./hooks/useFactoryRun";
export type { FactoryRunClient, FactoryRunHandle, UseFactoryRunInput } from "./hooks/useFactoryRun";
export {
  factoryRunElapsedMs,
  factoryRunRows,
  formatElapsed,
  groupFactoryRuns,
  needsYouCount,
} from "./services/factory-run-list";
export type { FactoryGroupId, FactoryRunGroup, FactoryRunRow } from "./services/factory-run-list";
export { createTauriFactoryRunsClient, useFactoryRuns } from "./hooks/useFactoryRuns";
export type { FactoryRunsClient, FactoryRunsHandle } from "./hooks/useFactoryRuns";
export { FactoryNavRow } from "./components/FactoryNavRow";
export { FactorySurface } from "./components/FactorySurface";
export { factoryRetryInput, factoryRunDetail, failingLines } from "./services/factory-run-detail";
export type { FactoryAction, FactoryRunDetail } from "./services/factory-run-detail";
export { FactoryRunDetailPane, createTauriFactoryRunActions } from "./components/FactoryRunDetailPane";
export type { FactoryRunActions } from "./components/FactoryRunDetailPane";
export { factoryProgressLine, factoryStageBar, factoryStepRows } from "./services/factory-progress";
export type { FactoryStageSegment, FactoryStageStatus, FactoryStepRow } from "./services/factory-progress";
export { factoryBoardColumn, factoryBoardColumns, factoryCardLine, factoryIntakeWaiting } from "./services/factory-board";
export type { FactoryBoardColumn, FactoryColumnId } from "./services/factory-board";
export { FactoryStageBar } from "./components/FactoryStageBar";
export type { FactoryTab } from "./components/FactorySurface";
export { FactoryRunCard } from "./components/FactoryRunCard";
export { factoryGroupOf } from "./services/factory-run-list";
export type { FactoryRunFacts } from "./services/factory-run-detail";
export { FactoryNewRunSheet } from "./components/FactoryNewRunSheet";
export {
  busyIssues,
  busyIssuesInWorkspace,
  createFactoryRunStarter,
  DEFAULT_CAP_USD,
  FACTORY_MAX_ATTEMPTS,
  filterIssues,
  newRunFooter,
} from "./services/factory-new-run";
export type {
  FactoryBatchRequest,
  FactoryBatchResult,
  FactoryIssue,
  FactoryNewRunSource,
  FactoryNotionSource,
  FactoryRepo,
  FactoryRunStarterDeps,
  FactoryWorkspace,
  FactoryWorkspaceInfo,
} from "./services/factory-new-run";
export { factoryIssueTitle, factoryNextStep, factoryNodeView } from "./services/factory-node";
export { keepNotionRepo, keptNotionRepo, notionTicketBody } from "./services/factory-notion";
export type { FactoryNodeView } from "./services/factory-node";
export { onOpenFactoryRunRequest, requestOpenFactoryRun } from "./services/factory-open-request";
export type { FactoryOpenRequest } from "./services/factory-open-request";
export { createFactoryRunsStore, useFactoryRunRow, useSharedFactoryRuns } from "./hooks/useSharedFactoryRuns";
export type { FactoryRunsSnapshot, FactoryRunsStore } from "./hooks/useSharedFactoryRuns";
export { FactoryRunNodeCard } from "./components/FactoryRunNodeCard";
export { brainstormWorkspace, factoryBrainstormPrompt } from "./services/factory-brainstorm";
export type { FactoryAgentsSource } from "./services/factory-agents";

/**
 * Automations' public face. A host (the workspace shell for Code and Chat, Canvas, anything later)
 * imports from here, never from inside the module: what is exported is the contract, the rest may
 * move. See AGENTS.md › Hosting.
 */
export { AutomationPanel } from "./containers/AutomationPanel";
export type { AutomationPanelProps } from "./containers/AutomationPanel";
export { AutomationSurface } from "./components/AutomationSurface";
export type { AutomationSurfaceProps, WaitingElsewhere } from "./components/AutomationSurface";
export { AutomationNavRow } from "./components/AutomationNavRow";
export { usePendingDraftCount, usePendingDrafts } from "./hooks/usePendingDraftCount";
export { isAsk, pendingByAutomation, waitingItems, waitsForYou } from "./services/inbox-model";
export { surfaceFit } from "./services/surface-fit";
export { createTauriAutomationClient, subscribeToAutomationChanges } from "./services/automation-api";
export { clearOpenAskRequest, openAskRequest, requestOpenAsk, subscribeToOpenAskRequest } from "./services/open-ask-request";
export type { OpenAskRequest } from "./services/open-ask-request";
export type { AutomationClient, AutomationDraft, AutomationProject, Subscribe } from "./services/automation-api";
export type { AgentWatchHost, Watch, WatchedAgent } from "./services/agent-watch";

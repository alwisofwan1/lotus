import { bridgeForgetCanvasCell } from "@/lib/tauri-api";
import { agentIdentityRegistry } from "./agent-identity-registry";
import { agentStateRegistry } from "./narration/agent-state-registry";
import { agentHeadlineStore } from "./agent-headline-store";
import { paneAskBuffer } from "./pane-ask-buffer";
import { canvasHandoffStore } from "./canvas-handoff-store";

/** All close surfaces forget runtime identity only after their agent has stopped. */
export function forgetClosedAgent(paneId: string, nodeId: string, sessionId?: string | null): void {
  agentIdentityRegistry.forget(paneId);
  if (sessionId) agentIdentityRegistry.forget(`session:${sessionId}`);
  agentStateRegistry.clear(paneId);
  agentHeadlineStore.clear(paneId);
  paneAskBuffer.clear(paneId);
  canvasHandoffStore.clear(nodeId);
  void bridgeForgetCanvasCell(paneId).catch((error) => console.warn("[canvas] fleet cleanup failed:", error));
}

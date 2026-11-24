import type { AgentStreamEvent } from "./agent-stream-parser";
import type { AgentNodeStatus } from "../types/canvas";

export interface AgentRuntimeState {
  status: AgentNodeStatus;
  sessionId: string | null;
}

export const INITIAL_AGENT_STATE: AgentRuntimeState = {
  status: "idle",
  sessionId: null,
};

/** Derives the next agent runtime status from one parsed stream event. Pure. */
export function agentStatusReducer(state: AgentRuntimeState, event: AgentStreamEvent): AgentRuntimeState {
  const terminal = state.status === "completed" || state.status === "error";
  switch (event.kind) {
    case "session":
      return { ...state, status: "running", sessionId: event.sessionId };
    case "text":
    case "tool":
      return { ...state, status: "running" };
    case "result":
      return { ...state, status: event.ok ? "completed" : "error" };
    case "exit":
      if (terminal) return state;
      return { ...state, status: event.code === 0 ? "completed" : "error" };
    default:
      return state;
  }
}

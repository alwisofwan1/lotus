import type { AgentStreamEvent } from "./agent-stream-parser";

/** One ordered piece of a run: either the agent's prose (a message) or a tool action it took. */
export type AgentRunEntry =
  | { kind: "message"; text: string }
  | { kind: "tool"; label: string };

export interface AgentRunView {
  entries: AgentRunEntry[];
}

export const EMPTY_RUN_VIEW: AgentRunView = { entries: [] };

/** Folds one stream event into the structured run view, keeping messages and tool activity distinct. Pure. */
export function agentRunViewReducer(view: AgentRunView, event: AgentStreamEvent): AgentRunView {
  if (event.kind === "text") return { entries: [...view.entries, { kind: "message", text: event.text }] };
  if (event.kind === "tool") return { entries: [...view.entries, { kind: "tool", label: event.label }] };
  return view;
}

export function runViewMessages(view: AgentRunView): string[] {
  return view.entries.flatMap((e) => (e.kind === "message" ? [e.text] : []));
}

export function runViewActivity(view: AgentRunView): string[] {
  return view.entries.flatMap((e) => (e.kind === "tool" ? [e.label] : []));
}

/** The agent's most recent prose — the headline answer shown when activity is collapsed. */
export function runViewFinalMessage(view: AgentRunView): string {
  const messages = runViewMessages(view);
  return messages.length ? messages[messages.length - 1] : "";
}

/** Flat chronological labels for the persisted run trace (messages + tool actions in order). */
export function runViewActions(view: AgentRunView): string[] {
  return view.entries.map((e) => (e.kind === "message" ? e.text : e.label));
}

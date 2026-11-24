/*
 * Where "send this selection to an agent" (⌘L) goes, without the Editor knowing.
 *
 * The rule, in every mode: the text lands in the composer of the nearest agent on the SAME
 * surface as the Editor, is never sent by itself, and never takes the user to another mode.
 *
 * The Editor pane only names itself (its cell id) and the text. Each surface that can hold an
 * Editor registers a resolver here and answers for the panes it owns: the workspace shell's Code
 * mode answers with a Thread pane today; a Canvas that hosts an Editor node would register its own
 * resolver answering with an AgentNode. A resolver returns `null` for a pane that is not its own,
 * so several can be registered at once without knowing about each other.
 *
 * Module state rather than React context for the same reason as `workbench-open.ts`: the pane
 * that asks and the surface that answers are not in one tree on every route.
 */

export type SelectionSendResult = { ok: true } | { ok: false; reason: string };

/** Answers for the panes it owns, `null` for any other. */
export type SelectionSendResolver = (sourceCellId: string, text: string) => SelectionSendResult | null;

const resolvers = new Set<SelectionSendResolver>();

export function onSelectionSend(resolver: SelectionSendResolver): () => void {
  resolvers.add(resolver);
  return () => {
    resolvers.delete(resolver);
  };
}

export const NO_AGENT_SURFACE_REASON = "There is no agent in this view to send the selection to.";

export function sendSelectionToAgent(sourceCellId: string, text: string): SelectionSendResult {
  if (!text.trim()) return { ok: false, reason: "Nothing is selected." };
  for (const resolver of resolvers) {
    const result = resolver(sourceCellId, text);
    if (result) return result;
  }
  return { ok: false, reason: NO_AGENT_SURFACE_REASON };
}

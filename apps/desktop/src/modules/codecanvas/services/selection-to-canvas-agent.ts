/**
 * Code's "Send to thread" on the board (plans/canvas-code, S4): the canvas answer to ⌘L, the way
 * CodeSpace's Code mode answers it with a Thread (`workspace-shell/services/selection-routing.ts`).
 * Same rule: the text lands in the agent's composer, is never submitted, and the user is not taken
 * anywhere. `candidates` are node ids in preference order; `insertInto` types into one and says
 * whether it could (a live PTY agent registers `insert` in the agent reply registry).
 */
export type CanvasSelectionRoute = { ok: true; nodeId: string } | { ok: false; reason: string };

export function routeSelectionToCanvasAgent(input: {
  text: string;
  candidates: readonly string[];
  insertInto: (nodeId: string, text: string) => boolean;
}): CanvasSelectionRoute {
  for (const nodeId of input.candidates) {
    if (input.insertInto(nodeId, input.text)) return { ok: true, nodeId };
  }
  return { ok: false, reason: "There is no agent on this board that can take the selection." };
}

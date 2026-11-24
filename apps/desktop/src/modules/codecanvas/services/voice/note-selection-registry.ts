/**
 * Note-selection bridge (ADR-0034, Option D). A mounted NoteNode editor registers a handle keyed by
 * its node id; the NL command bar reads the Focused note's current selection (to build the Canvas
 * Voice Context and decide a `transform` outcome) and writes the transformed text back — without the
 * bar importing Tiptap or the editor internals. Module singleton, mirroring `agentStatusRegistry`.
 */
export interface NoteSelectionHandle {
  /** The text currently selected in the editor, or "" when the selection is empty. */
  getSelectedText(): string;
  /** Replace the current selection with `markdown` (rendered), leaving the caret after it. */
  replaceSelection(markdown: string): void;
}

const handles = new Map<string, NoteSelectionHandle>();

export const noteSelectionRegistry = {
  register(nodeId: string, handle: NoteSelectionHandle): () => void {
    handles.set(nodeId, handle);
    return () => {
      // Only remove if still the same handle (guards against an unmount racing a remount).
      if (handles.get(nodeId) === handle) handles.delete(nodeId);
    };
  },
  get(nodeId: string): NoteSelectionHandle | undefined {
    return handles.get(nodeId);
  },
  /** The selected text for a node, or "" when unregistered or nothing is selected. */
  selectedText(nodeId: string): string {
    try {
      return handles.get(nodeId)?.getSelectedText() ?? "";
    } catch {
      return "";
    }
  },
};

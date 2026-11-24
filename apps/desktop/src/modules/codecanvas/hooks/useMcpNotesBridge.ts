"use client";
import { useEffect, useRef } from "react";
import type { Edge, Node, XYPosition } from "@xyflow/react";
import { bridgeResolveMcpRequest, notesBridgeSetCanvas } from "@/lib/tauri-api";
import { isTauri, loadTauriCore } from "@/lib/tauri/runtime";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import { planAgentNoteWrite, type AgentNoteWrite } from "../services/nodes/note-agent-write";
import { noteAgentWire } from "../services/nodes/note-agent-link";

const EVENT = "mcp://notes-write";
/** Rust wrote a note to the STORE (no canvas was registered for its project). */
const WRITTEN_EVENT = "notes://written";

interface NotesWritePayload {
  requestId: string;
  write: AgentNoteWrite;
}

interface NotesWrittenPayload {
  write: AgentNoteWrite;
  note: { id: string; content?: string; editedAt?: number; editedBy?: string };
}

export interface McpNotesBridgeDeps {
  projectId: string | null;
  nodes: readonly Node[];
  edges: readonly Edge[];
  writeNote: (nodeId: string, content: string, editedBy: string | undefined, editedAt: number) => void;
  addNoteNode: (at: XYPosition | undefined, content: string, options: { id: string; takeCaret: false }) => string;
  patchNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  appendDispatch: (nodes: Node[], edges: Edge[]) => void;
}

/** The note's editor has focus in edit mode — the user is writing in it right now. */
function isUserTyping(noteId: string): boolean {
  if (typeof document === "undefined") return false;
  const node = document.querySelector(`.react-flow__node[data-id="${CSS.escape(noteId)}"]`);
  if (!node || !node.contains(document.activeElement)) return false;
  return node.querySelector('[data-note-mode="edit"]') !== null;
}

/**
 * The open canvas's half of the note write path (ADR-0047). It tells Rust which project this window
 * has mounted, so an agent's write to that project comes HERE instead of the store — the editor shows
 * it at once and the canvas autosave carries it, rather than overwriting it a second later. Each write
 * is re-checked against the canvas's own, fresher state before it is applied.
 */
export function useMcpNotesBridge(deps: McpNotesBridgeDeps): void {
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });
  // Rust may re-emit on a client retry; apply each requestId once.
  const handledRef = useRef<Set<string>>(new Set());
  const { projectId } = deps;

  useEffect(() => {
    if (!isTauri()) return;
    // A failure here is not cosmetic: without the registration Rust writes agent edits to the store,
    // where the open canvas's next autosave would overwrite them. Say so in the log.
    const register = (id: string | null) =>
      notesBridgeSetCanvas(id).catch((error: unknown) => console.warn("[notes] canvas registration failed", error));
    void register(projectId);
    return () => {
      void register(null);
    };
  }, [projectId]);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let unlistenWritten: (() => void) | null = null;

    void (async () => {
      await loadTauriCore();
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen<NotesWritePayload>(EVENT, (event) => {
        const { requestId, write } = event.payload ?? ({} as NotesWritePayload);
        if (!requestId || !write || handledRef.current.has(requestId)) return;
        handledRef.current.add(requestId);
        const resolve = (ok: boolean, data?: unknown, error?: string) =>
          void bridgeResolveMcpRequest({ requestId, ok, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) });

        const current = depsRef.current;
        if (current.projectId !== write.projectId) {
          resolve(false, undefined, "this canvas no longer has that project open — try again");
          return;
        }
        const plan = planAgentNoteWrite(write, { nodes: current.nodes, isUserTyping });
        if (!plan.ok) {
          resolve(false, undefined, plan.error);
          return;
        }
        const editedAt = Date.now();
        if (plan.kind === "create") {
          current.addNoteNode(plan.at, plan.content, { id: plan.noteId, takeCaret: false });
          current.patchNodeData(plan.noteId, { editedAt, editedBy: write.author });
          if (plan.wireTo) current.appendDispatch([], [noteAgentWire(plan.noteId, plan.wireTo)]);
        } else {
          current.writeNote(plan.noteId, plan.content, write.author, editedAt);
        }
        const linkedNodeIds = [
          ...new Set([
            ...current.edges.flatMap((edge) =>
              edge.source === plan.noteId ? [edge.target] : edge.target === plan.noteId ? [edge.source] : [],
            ),
            ...(plan.kind === "create" && plan.wireTo ? [plan.wireTo] : []),
          ]),
        ];
        const existing = current.nodes.find((node) => node.id === plan.noteId)?.data as { noteNumber?: number; coverUri?: string } | undefined;
        resolve(true, {
          id: plan.noteId,
          content: plan.content,
          editedAt,
          ...(write.author ? { editedBy: write.author } : {}),
          ...(existing?.noteNumber ? { noteNumber: existing.noteNumber } : {}),
          ...(existing?.coverUri ? { coverUri: existing.coverUri } : {}),
          linkedNodeIds,
        });
      });
      if (disposed) safeTauriUnlisten(un);
      else unlisten = un;

      // Safety net: Rust wrote to the store because it did not know this canvas had the project
      // open. Adopt the write — otherwise this canvas's next autosave would silently erase it.
      const unWritten = await listen<NotesWrittenPayload>(WRITTEN_EVENT, (event) => {
        const { write, note } = event.payload ?? ({} as NotesWrittenPayload);
        const current = depsRef.current;
        if (!write || !note?.id || current.projectId !== write.projectId || typeof note.content !== "string") return;
        const editedAt = note.editedAt ?? Date.now();
        if (current.nodes.some((node) => node.id === note.id)) {
          if (isUserTyping(note.id)) console.warn("[notes] agent write landed while the user was typing in that note", note.id);
          current.writeNote(note.id, note.content, note.editedBy, editedAt);
          return;
        }
        if (write.mode !== "create") return;
        const plan = planAgentNoteWrite(write, { nodes: current.nodes, isUserTyping });
        if (!plan.ok || plan.kind !== "create") return;
        current.addNoteNode(plan.at, note.content, { id: note.id, takeCaret: false });
        current.patchNodeData(note.id, { editedAt, editedBy: note.editedBy });
        if (plan.wireTo) current.appendDispatch([], [noteAgentWire(note.id, plan.wireTo)]);
      });
      if (disposed) safeTauriUnlisten(unWritten);
      else unlistenWritten = unWritten;
    })();

    return () => {
      disposed = true;
      if (unlisten) safeTauriUnlisten(unlisten);
      if (unlistenWritten) safeTauriUnlisten(unlistenWritten);
    };
  }, []);
}

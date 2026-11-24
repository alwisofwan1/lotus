import type { Node, XYPosition } from "@xyflow/react";
import { getNodeSize } from "../canvas-node-placement";

/** Mirrors `MAX_NOTE_CHARS` in src-tauri/src/notes_write.rs. */
export const MAX_NOTE_CHARS = 100_000;
const NEW_NOTE_GAP = 80;

export type AgentNoteWriteMode = "append" | "replace" | "create";

/** A write Rust already resolved (target, author, conflict check against the store) — ADR-0047. */
export interface AgentNoteWrite {
  projectId: string;
  mode: AgentNoteWriteMode;
  noteId: string;
  markdown: string;
  nextContent: string;
  expectedEditedAt?: number;
  author?: string;
  callerNodeId?: string;
}

export type AgentNoteWritePlan =
  | { ok: true; kind: "update"; noteId: string; content: string }
  | { ok: false; error: string }
  | { ok: true; kind: "create"; noteId: string; content: string; at?: XYPosition; wireTo?: string };

/** Same rule as Rust's `next_content`: append adds the markdown as its own block. */
export function nextNoteContent(mode: AgentNoteWriteMode, current: string, markdown: string): string {
  if (mode !== "append") return markdown;
  const head = current.trimEnd();
  return head ? `${head}\n\n${markdown.trimStart()}` : markdown.trimStart();
}

interface PlanContext {
  nodes: readonly Node[];
  /** The note's editor has focus in edit mode — the user is writing in it right now. */
  isUserTyping: (noteId: string) => boolean;
}

/**
 * Decide how the OPEN canvas applies an agent's write. The canvas re-checks against its own,
 * fresher state: Rust's conflict check saw the store, which lags the editor by about a second.
 */
export function planAgentNoteWrite(write: AgentNoteWrite, ctx: PlanContext): AgentNoteWritePlan {
  if (write.mode === "create") {
    const caller = write.callerNodeId ? ctx.nodes.find((node) => node.id === write.callerNodeId) : undefined;
    const at = caller
      ? { x: caller.position.x - getNodeSize({ type: "note" } as Node).w - NEW_NOTE_GAP, y: caller.position.y }
      : undefined;
    return { ok: true, kind: "create", noteId: write.noteId, content: write.markdown, at, wireTo: caller?.id };
  }
  const note = ctx.nodes.find((node) => node.id === write.noteId && node.type === "note");
  if (!note) return { ok: false, error: `note '${write.noteId}' is no longer on the canvas` };
  if (ctx.isUserTyping(write.noteId)) {
    return {
      ok: false,
      error: "the user is typing in this note right now — nothing was written. Try again in a few seconds, or use mode 'create' for a new note.",
    };
  }
  const data = note.data as { content?: unknown; editedAt?: unknown };
  if (write.expectedEditedAt !== undefined && data.editedAt !== write.expectedEditedAt) {
    return {
      ok: false,
      error: `conflict: the note changed since you read it (editedAt is now ${typeof data.editedAt === "number" ? data.editedAt : "unset"}). Read it again with lotus_notes_read, then write.`,
    };
  }
  const content = nextNoteContent(write.mode, typeof data.content === "string" ? data.content : "", write.markdown);
  if (content.length > MAX_NOTE_CHARS) {
    return { ok: false, error: `the note would be ${content.length} characters; the limit is ${MAX_NOTE_CHARS}. Create a new note instead.` };
  }
  return { ok: true, kind: "update", noteId: write.noteId, content };
}

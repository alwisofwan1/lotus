"use client";
import { memo, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
// NoteNode follows the same drag contract as every other Canvas node (TaskNode, PlanNode, …):
// the body content is `nodrag nowheel` and the node is dragged by its header.
//
// The note has two modes. READ is the default for a note that already has content: no caret, text
// selectable, checkboxes still clickable — a surface that is safe to look at and click on. EDIT
// starts when you click the text (or pick "Edit note" in the ··· menu, or create a new note), and
// shows itself with a sage ring plus "Editing · Esc to finish" in the header (ADR-0046). There is
// no read|edit pill any more. The body stays `nodrag nowheel` in both modes, so the drag contract
// never changes and there are no drag overlays.
import type { NodeProps } from "@xyflow/react";
import { Bot, ImageMinus, ImagePlus, PencilLine, Zap } from "lucide-react";
import { CanvasNodeFrame } from "./CanvasNodeFrame";
import { NoteNodeHeader, type NoteHeaderMenuItem } from "./NoteNodeHeader";
import { NoteNodeFooter } from "./NoteNodeFooter";
import { NoteNodeGlyph } from "./NoteNodeGlyph";
import { NoteNodeCover } from "./NoteNodeCover";
import { imageFileToNoteAssetUri } from "../../services/note-assets";
import { useCanvasProjectId } from "../CanvasGraphRunProvider";
import { RichMarkdownNoteEditor } from "./RichMarkdownNoteEditor";
import { useCanvasLodTier } from "../../hooks/useCanvasLodTier";
import { SmartConvertModal } from "../SmartConvertModal";
import { deriveNoteTitle, noteTaskProgress } from "../../services/nodes/note-title";
import { wasNoteJustSpawned } from "../../services/nodes/note-spawn-focus";
import type { NoteNodePatch, SmartConvertDraft } from "../../types/canvas";
import type { DispatchCanvasNodeCommand } from "../../services/nodes/canvas-node-command";

type NoteMode = "read" | "edit";

/**
 * A click in read mode that should NOT start editing: ticking a checkbox (reading, not writing),
 * using an image's own controls, or finishing a drag-select of text to copy it.
 */
function isReadModeInteraction(event: MouseEvent<HTMLElement>): boolean {
  const target = event.target as HTMLElement;
  if (target.closest("label, input, button, a, .canvas-note-image-controls, .canvas-note-footer, .canvas-note-quickadd, .canvas-note-cover")) return true;
  const selection = typeof window === "undefined" ? null : window.getSelection();
  return Boolean(selection && !selection.isCollapsed);
}

export interface NoteNodeData {
  content: string;
  noteNumber?: number;
  /** Epoch ms of the last content change (persisted) — the footer's "Edited …" line. */
  editedAt?: number;
  /** `lotus-note-asset://<id>` of the optional cover image. */
  coverUri?: string;
  /** The agent that wrote the last change (ADR-0047); cleared by a user edit. */
  editedBy?: string;
  dispatchCommand?: DispatchCanvasNodeCommand;
  onNoteChange?: (nodeId: string, content: string) => void;
  onClose?: (nodeId: string) => void;
  onConvert?: (nodeId: string, draft: SmartConvertDraft) => void;
  onNotePatch?: (nodeId: string, patch: NoteNodePatch) => void;
  [key: string]: unknown;
}

export const NoteNode = memo(function NoteNode({ id, data, selected }: NodeProps) {
  const { content, noteNumber, editedAt, editedBy, coverUri, dispatchCommand, onNoteChange, onClose, onConvert, onNotePatch } = data as NoteNodeData;
  const lodTier = useCanvasLodTier();
  const projectId = useCanvasProjectId();
  // One derivation feeds the header tooltip AND the zoomed-out glyph, so the note is called the same
  // thing at every zoom level. Reads the first line only — a note can hold a large document and
  // this runs on render.
  const title = useMemo(() => deriveNoteTitle(content, noteNumber), [content, noteNumber]);
  const progress = useMemo(() => noteTaskProgress(content), [content]);
  const [showModal, setShowModal] = useState(false);
  // A note with content opens as a document; an empty one opens ready to type.
  const [mode, setMode] = useState<NoteMode>(() => (content.trim() ? "read" : "edit"));
  // Only a note created a moment ago may take the caret on mount — restoring a snapshot with
  // several empty notes must not have them fight over the keyboard. Evaluated once, at mount;
  // the TTL registry is idempotent, so StrictMode's double-invoked initializer agrees with itself.
  const [caretOnMount] = useState(() => wasNoteJustSpawned(id));
  const editing = mode === "edit";
  // An empty note shows the quick-add row where the footer would be — there is nothing to report yet.
  const isEmpty = !content.trim();

  const coverInputRef = useRef<HTMLInputElement>(null);
  const patchNote = (patch: NoteNodePatch) => {
    if (dispatchCommand) dispatchCommand({ kind: "patch-note", nodeId: id, patch });
    else onNotePatch?.(id, patch);
  };
  // A cover is stored in the project's note-asset store, so it needs a project to live in.
  const canStoreCover = Boolean(projectId);
  const pickCover = () => coverInputRef.current?.click();

  // Needs the node command seam — the canvas owns spawning and wiring.
  const spawnAgent = dispatchCommand ? () => dispatchCommand({ kind: "note-spawn-agent", nodeId: id }) : undefined;

  const menuItems: NoteHeaderMenuItem[] = [
    ...(editing
      ? []
      : [{ id: "edit", label: "Edit note", hint: "Or click the text", icon: <PencilLine size={14} />, onSelect: () => setMode("edit") }]),
    ...(canStoreCover
      ? [{ id: "cover", label: coverUri ? "Change cover" : "Add cover", hint: "A photo across the top", icon: <ImagePlus size={14} />, onSelect: pickCover }]
      : []),
    ...(coverUri
      ? [{ id: "remove-cover", label: "Remove cover", icon: <ImageMinus size={14} />, onSelect: () => patchNote({ coverUri: null }) }]
      : []),
    ...(spawnAgent
      ? [{ id: "agent", label: "Add agent", hint: "A new agent that reads this note", icon: <Bot size={14} />, onSelect: spawnAgent }]
      : []),
    {
      id: "smart-convert",
      label: "Smart Convert",
      hint: "AI turns this note into a task",
      icon: <Zap size={14} />,
      onSelect: () => setShowModal(true),
    },
  ];

  return (
    <>
      <CanvasNodeFrame
        kind="note"
        selected={!!selected}
        minWidth={200}
        minHeight={150}
        lodTier={lodTier}
        glyph={<NoteNodeGlyph title={title} done={progress.done} total={progress.total} />}
        header={
          <NoteNodeHeader
            title={title}
            label={editing ? "Editing · Esc to finish" : "Note"}
            editing={editing}
            menuItems={menuItems}
            onFocus={dispatchCommand ? () => dispatchCommand({ kind: "focus-node", nodeId: id }) : undefined}
            onClose={() => {
              if (dispatchCommand) dispatchCommand({ kind: "close-node", nodeId: id });
              else onClose?.(id);
            }}
          />
        }
      >
        {/* The body is the editor's container. A click on the text starts editing; the ··· menu's
            "Edit note" is the keyboard-reachable way in, and Esc is the way out. */}
        <div
          className="canvas-node-body canvas-note-node-body nodrag nowheel"
          data-note-mode={mode}
          onClick={(event) => {
            if (mode === "read" && !isReadModeInteraction(event)) setMode("edit");
          }}
          onKeyDown={(event) => {
            // defaultPrevented: the slash menu already used this Esc to close itself.
            if (event.key !== "Escape" || !editing || event.defaultPrevented) return;
            // Handle Esc here so it leaves edit mode before the canvas reads it as "exit focus mode".
            event.stopPropagation();
            setMode("read");
          }}
          // Focus leaving the note also finishes editing — with no pill, the sage ring must not
          // stay on a note the user has clearly moved away from. Focus moving inside the node
          // (header menu) keeps it, and so does the app losing window focus (switching apps).
          onBlur={(event) => {
            if (!editing || !document.hasFocus()) return;
            const next = event.relatedTarget as Node | null;
            if (next && event.currentTarget.closest(".canvas-note-node")?.contains(next)) return;
            setMode("read");
          }}
        >
          {coverUri && <NoteNodeCover coverUri={coverUri} onChange={canStoreCover ? pickCover : undefined} onRemove={() => patchNote({ coverUri: null })} />}
          <RichMarkdownNoteEditor
            content={content}
            nodeId={id}
            projectId={projectId}
            editable={editing}
            autoFocus={caretOnMount}
            showQuickAdd={isEmpty}
            onAddCover={coverUri || !canStoreCover ? undefined : pickCover}
            onAddAgent={spawnAgent}
            onChange={(next) => {
              if (dispatchCommand) dispatchCommand({ kind: "note-change", nodeId: id, content: next });
              else onNoteChange?.(id, next);
            }}
          />
          {projectId && (
            <input
              ref={coverInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                void imageFileToNoteAssetUri(projectId, file).then((uri) => patchNote({ coverUri: uri }));
              }}
            />
          )}
          {!isEmpty && <NoteNodeFooter nodeId={id} progress={progress} editedAt={editedAt} editedBy={editedBy} />}
        </div>
      </CanvasNodeFrame>

      {showModal && (
        <SmartConvertModal
          noteContent={content}
          onConfirm={(draft) => {
            setShowModal(false);
            if (dispatchCommand) dispatchCommand({ kind: "note-convert", nodeId: id, draft });
            else onConvert?.(id, draft);
          }}
          onCancel={() => setShowModal(false)}
        />
      )}
    </>
  );
});

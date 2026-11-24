"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Image as ImageIcon, ImagePlus, ListChecks } from "lucide-react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { htmlToMarkdown, markdownToHtml, tiptapJsonToMarkdown } from "../../services/note-markdown-codec";
import { noteSelectionRegistry } from "../../services/voice/note-selection-registry";
import { dataUrlToNoteAssetUri, imageFileToNoteAssetUri } from "../../services/note-assets";
import { NoteImage } from "./note-editor/NoteImageView";
import { NoteBubbleMenu } from "./note-editor/NoteBubbleMenu";
import { SlashCommand } from "./note-editor/note-slash-command";

interface Props {
  content: string;
  /** React Flow node id — keys the note-selection bridge for voice selected-text transforms. */
  nodeId?: string;
  projectId?: string | null;
  /** Read ⇄ edit. The node owns the mode; Tiptap owns editability. Defaults to editable. */
  editable?: boolean;
  /** Allowed to take the caret on the very first mount (a note created a moment ago). */
  autoFocus?: boolean;
  /** Show the quick-add row (Checklist, Image) — a brand-new, still empty note (ADR-0046). */
  showQuickAdd?: boolean;
  /** Quick-add "Cover" chip; absent when the note already has a cover or cannot store one. */
  onAddCover?: () => void;
  /** Quick-add "Agent" chip: a new agent beside the note, wired to it. */
  onAddAgent?: () => void;
  onChange: (markdown: string) => void;
}

const DEBOUNCE_MS = 300;

/**
 * An empty note starts as an empty title (H1) plus an empty line, so the caret lands in the title
 * and "Untitled" shows there (ADR-0046). The first line IS the note's name everywhere else.
 */
const EMPTY_NOTE_HTML = "<h1></h1><p></p>";

/**
 * The codec writes an empty heading as "# ". Saving that would give an untouched note content
 * ("#") — it would reopen in read mode with a stray hash — so an empty leading title is dropped.
 */
function withoutEmptyLeadingHeading(markdown: string): string {
  return markdown.replace(/^#{1,6}[ \t]*(?:\n+|$)/, "");
}

function initialHtml(content: string): string {
  return content.trim() ? markdownToHtml(content) : EMPTY_NOTE_HTML;
}

/**
 * Per-node placeholder. The title says "Untitled"; the line under it explains the note; any other
 * empty line the caret is on gets the short slash hint. Everything else stays blank.
 */
function notePlaceholder({ editor, node, pos, hasAnchor }: { editor: Editor; node: { type: { name: string }; childCount: number }; pos: number; hasAnchor: boolean }): string {
  if (pos === 0 && node.type.name === "heading") return "Untitled";
  if (node.type.name !== "paragraph") return "";
  const doc = editor.state.doc;
  const titleSize = doc.firstChild?.type.name === "heading" ? doc.firstChild.nodeSize : -1;
  if (pos === titleSize && doc.childCount === 2) return "Start writing, or press / for blocks";
  return hasAnchor ? "Press / for blocks" : "";
}

/**
 * True when the user is mid-keystroke somewhere else — the NL command bar, a rename field, another
 * note. Entering edit mode must never yank the caret out from under them.
 */
function typingElsewhere(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement as HTMLElement | null;
  if (!active || active === document.body) return false;
  return active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable === true;
}

function commit(editor: Editor, onChange: (markdown: string) => void, last: { current: string }) {
  const markdown = withoutEmptyLeadingHeading(tiptapJsonToMarkdown(editor.getJSON()));
  if (markdown !== last.current) { last.current = markdown; onChange(markdown); }
}

function firstImage(files: FileList | File[]): File | null {
  return [...files].find((file) => file.type.startsWith("image/")) ?? null;
}

function nonImageFileLabels(files: FileList | File[]): string[] {
  return [...files].filter((file) => !file.type.startsWith("image/")).map((file) => file.name).filter(Boolean);
}

export function RichMarkdownNoteEditor({ content, nodeId, projectId, editable = true, autoFocus, showQuickAdd, onAddCover, onAddAgent, onChange }: Props) {
  const lastCommitted = useRef(content);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [draggingImage, setDraggingImage] = useState(false);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const scheduleCommit = useCallback((editor: Editor) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(editor, onChangeRef.current, lastCommitted), DEBOUNCE_MS);
  }, []);

  const editor = useEditor({
    immediatelyRender: false,
    editable,
    extensions: [
      // v1 toolbar contract is Bold, Italic, H1, H2, bullet list, checklist, image embed
      // (codecanvas-rich-markdown-note/plan.md decision #10). StarterKit otherwise keeps blockquote,
      // code, codeBlock, hardBreak, horizontalRule, link, orderedList, strike and underline switched
      // on by default — input rules and all — which the codec (note-markdown-codec.ts) has no
      // serializer for, so typing them was silently flattened on the next save. Disable exactly the
      // extensions the codec can't round-trip; S2-S4 re-enable them one at a time once it can.
      StarterKit.configure({
        heading: { levels: [1, 2] },
        blockquote: false,
        code: false,
        codeBlock: false,
        hardBreak: false,
        horizontalRule: false,
        link: false,
        orderedList: false,
        strike: false,
        underline: false,
      }),
      NoteImage,
      TaskList.configure({ HTMLAttributes: { class: "canvas-note-task-list" } }),
      TaskItem.configure({
        nested: false,
        HTMLAttributes: { class: "canvas-note-task-item" },
        // Ticking a box is reading, not editing: returning true lets the checkbox commit while the
        // editor is read-only, which is what makes read mode the DEFAULT mode instead of a dead end.
        onReadOnlyChecked: () => true,
      }),
      Placeholder.configure({ placeholder: notePlaceholder, showOnlyCurrent: false }),
      SlashCommand,
    ],
    content: initialHtml(content),
    editorProps: {
      attributes: {
        class: "canvas-note-editor",
        role: "textbox",
        "aria-label": "Note content",
        "aria-multiline": "true",
      },
      handlePaste: (_view, event) => {
        const active = editorRef.current;
        if (!active) return false;
        const clipboardData = event.clipboardData;
        if (!clipboardData) return false;
        const image = firstImage(clipboardData.files);
        if (image && projectId) {
          event.preventDefault();
          void imageFileToNoteAssetUri(projectId, image).then((src) => {
            active.chain().focus().setImage({ src, alt: image.name || "image" }).run();
            commit(active, onChangeRef.current, lastCommitted);
          });
          return true;
        }
        const html = clipboardData.getData("text/html");
        if (!html.trim()) return false;
        event.preventDefault();
        void htmlToMarkdown(html, {
          resolveDataImage: projectId ? ({ dataUrl, alt }) => dataUrlToNoteAssetUri(projectId, dataUrl, `${alt || "pasted-image"}.png`) : undefined,
        }).then((markdown) => {
          if (!markdown) return;
          active.chain().focus().insertContent(markdownToHtml(markdown)).run();
          commit(active, onChangeRef.current, lastCommitted);
        });
        return true;
      },
    },
    onUpdate: ({ editor }) => scheduleCommit(editor),
  });

  useEffect(() => { editorRef.current = editor; }, [editor]);

  // Mode plumbing. Entering edit takes the caret so the pill/double-click lands the user on the
  // text directly; on the FIRST run only a just-spawned note may (autoFocus), because a snapshot
  // restore mounts every note at once. Leaving edit flushes the pending debounce so the mode swap
  // is also the save point.
  const wasEditable = useRef<boolean | null>(null);
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const firstRun = wasEditable.current === null;
    wasEditable.current = editable;
    editor.setEditable(editable);
    if (editable) {
      if ((!firstRun || autoFocus) && !typingElsewhere()) editor.commands.focus();
      return;
    }
    if (!firstRun) commit(editor, onChangeRef.current, lastCommitted);
  }, [editor, editable, autoFocus]);

  // Register a selection handle so the NL command bar can read + rewrite the current selection for a
  // voice/typed selected-text transform (ADR-0034, Option D). The selection persists in ProseMirror
  // state even after the editor blurs (e.g. when the user clicks the command bar), so it stays valid.
  useEffect(() => {
    if (!editor || !nodeId) return;
    return noteSelectionRegistry.register(nodeId, {
      getSelectedText: () => {
        if (editor.isDestroyed) return "";
        const { from, to } = editor.state.selection;
        return from === to ? "" : editor.state.doc.textBetween(from, to, "\n");
      },
      replaceSelection: (markdown) => {
        if (editor.isDestroyed) return;
        const { from, to } = editor.state.selection;
        editor.chain().focus().insertContentAt({ from, to }, markdownToHtml(markdown)).run();
        commit(editor, onChangeRef.current, lastCommitted);
      },
    });
  }, [editor, nodeId]);
  useEffect(() => {
    if (!editor || content === lastCommitted.current) return;
    const currentMarkdown = withoutEmptyLeadingHeading(tiptapJsonToMarkdown(editor.getJSON()));
    if (currentMarkdown === content) {
      lastCommitted.current = content;
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    lastCommitted.current = content;
    const nextHtml = initialHtml(content);
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled || editor.isDestroyed) return;
      editor.commands.setContent(nextHtml, { emitUpdate: false });
    });
    return () => { cancelled = true; };
  }, [content, editor]);
  const flush = useCallback(() => { if (editor) commit(editor, onChangeRef.current, lastCommitted); }, [editor]);
  const insertImage = useCallback(async (file: File) => {
    if (!editor || !projectId) return false;
    const src = await imageFileToNoteAssetUri(projectId, file);
    editor.chain().focus().setImage({ src, alt: file.name || "image" }).run();
    commit(editor, onChangeRef.current, lastCommitted);
    return true;
  }, [editor, projectId]);
  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!firstImage(event.dataTransfer.files)) return;
    event.preventDefault();
    setDraggingImage(true);
  }, []);
  const onDrop = useCallback((event: React.DragEvent) => {
    const image = firstImage(event.dataTransfer.files);
    setDraggingImage(false);
    if (image) {
      event.preventDefault();
      void insertImage(image);
      return;
    }
    const labels = nonImageFileLabels(event.dataTransfer.files);
    if (labels.length === 0 || !editor) return;
    event.preventDefault();
    editor.chain().focus().insertContent(labels.join("\n")).run();
    commit(editor, onChangeRef.current, lastCommitted);
  }, [editor, insertImage]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); flush(); }, [flush]);

  return (
    <>
      <NoteBubbleMenu editor={editor} />
      <EditorContent
        data-testid="rich-markdown-note-editor"
        className="canvas-note-editor-shell"
        editor={editor}
        onBlur={flush}
        onDragOver={onDragOver}
        onDragLeave={() => setDraggingImage(false)}
        onDrop={onDrop}
      />
      {showQuickAdd && editor && (
        <div className="canvas-note-quickadd nodrag" role="toolbar" aria-label="Add to note">
          {onAddCover && (
            <button
              type="button"
              className="canvas-note-chip"
              onClick={(event) => {
                event.stopPropagation();
                onAddCover();
              }}
            >
              <ImageIcon size={12} aria-hidden />
              Cover
            </button>
          )}
          <button
            type="button"
            className="canvas-note-chip"
            onClick={(event) => {
              event.stopPropagation();
              editor.chain().focus("end").toggleTaskList().run();
            }}
          >
            <ListChecks size={12} aria-hidden />
            Checklist
          </button>
          {projectId && (
            <label className="canvas-note-chip" onClick={(event) => event.stopPropagation()}>
              <ImagePlus size={12} aria-hidden />
              Image
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void insertImage(file);
                }}
              />
            </label>
          )}
          {onAddAgent && (
            <button
              type="button"
              className="canvas-note-chip"
              onClick={(event) => {
                event.stopPropagation();
                onAddAgent();
              }}
            >
              <Bot size={12} aria-hidden />
              Agent
            </button>
          )}
        </div>
      )}
      {draggingImage && (
        <div className="canvas-note-drop-overlay nodrag" role="status">
          Drop image to embed
        </div>
      )}
    </>
  );
}

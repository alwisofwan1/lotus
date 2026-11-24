"use client";
import { BubbleMenu } from "@tiptap/react/menus";
import { useEditorState, type Editor } from "@tiptap/react";
import { Bold, Heading1, Heading2, Italic, List, ListChecks } from "lucide-react";

interface Props {
  editor: Editor | null;
}

/**
 * Selection-triggered inline formatting menu (Notion-style). Replaces the always-on
 * toolbar — nothing chromes the note until the user actually selects text. Active marks
 * light up via `useEditorState`, which subscribes to a thin state slice instead of
 * forcing a full editor re-render on every keystroke.
 */
export function NoteBubbleMenu({ editor }: Props) {
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive("bold"),
            italic: e.isActive("italic"),
            h1: e.isActive("heading", { level: 1 }),
            h2: e.isActive("heading", { level: 2 }),
            bullet: e.isActive("bulletList"),
            task: e.isActive("taskList"),
          }
        : null,
  });

  if (!editor) return null;

  return (
    <BubbleMenu
      editor={editor}
      className="canvas-note-bubble nodrag"
      shouldShow={({ editor: e, from, to }) => from !== to && !e.isActive("image")}
      // Keep the editor focused (and the note in edit mode) while using the toolbar.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button type="button" aria-label="Bold" data-active={active?.bold || undefined} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold size={13} aria-hidden />
      </button>
      <button type="button" aria-label="Italic" data-active={active?.italic || undefined} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic size={13} aria-hidden />
      </button>
      <span className="canvas-note-bubble-divider" aria-hidden />
      <button type="button" aria-label="Heading 1" data-active={active?.h1 || undefined} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
        <Heading1 size={14} aria-hidden />
      </button>
      <button type="button" aria-label="Heading 2" data-active={active?.h2 || undefined} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        <Heading2 size={14} aria-hidden />
      </button>
      <span className="canvas-note-bubble-divider" aria-hidden />
      <button type="button" aria-label="Bullet list" data-active={active?.bullet || undefined} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List size={14} aria-hidden />
      </button>
      <button type="button" aria-label="Checklist" data-active={active?.task || undefined} onClick={() => editor.chain().focus().toggleTaskList().run()}>
        <ListChecks size={14} aria-hidden />
      </button>
    </BubbleMenu>
  );
}

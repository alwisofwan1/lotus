import { Extension, type Editor } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import StarterKit from "@tiptap/starter-kit";

import { MentionNode, type MentionChip } from "./ChatMention";

// The Tiptap setup the thread composer and the Chat home share.

/** Plain text, `@` chips, and Enter that sends (Shift+Enter breaks the line). Both callbacks are
 *  read when they run, so callers pass functions that read refs. */
export function chatEditorExtensions({ placeholder, onEnter }: { placeholder: () => string; onEnter: () => void }) {
  return [
    // Plain text: no marks or blocks, so what the agent gets is what was typed.
    StarterKit.configure({
      blockquote: false,
      bold: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      italic: false,
      link: false,
      listItem: false,
      listKeymap: false,
      orderedList: false,
      strike: false,
      underline: false,
    }),
    Placeholder.configure({ placeholder }),
    MentionNode,
    Extension.create({
      name: "chatSubmit",
      addKeyboardShortcuts: () => ({
        Enter: ({ editor }) => {
          if (editor.view.composing) return false;
          onEnter();
          return true;
        },
      }),
    }),
  ];
}

/** What the pickers read: the text before the caret. A chip reads as a space; it ends a word. */
export function textBeforeCaret(editor: Editor): string {
  return editor.state.doc.textBetween(0, editor.state.selection.from, "\n", " ");
}

/** Replaces the `typed` chars before the caret with `text`, or with a chip and a space. A text
 *  node, not a string: a string is parsed as HTML, which drops the trailing space. */
export function insertAtCaret(editor: Editor | null, text: string, typed: number, chip?: MentionChip): void {
  if (!editor) return;
  const to = editor.state.selection.from;
  const content = chip ? [{ type: "mention", attrs: chip }, { type: "text", text: " " }] : { type: "text", text };
  editor.chain().focus().insertContentAt({ from: to - typed, to }, content).run();
}

/** Lines as paragraphs, the shape `setContent` and `insertContent` take. */
export function paragraphs(text: string) {
  return text.split("\n").map((line) => ({ type: "paragraph", content: line ? [{ type: "text", text: line }] : [] }));
}

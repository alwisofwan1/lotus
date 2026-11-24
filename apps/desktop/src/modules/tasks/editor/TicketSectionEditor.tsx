"use client";

import { useEffect, useRef, useState } from "react";
import { Editor } from "@tiptap/core";
import BubbleMenu from "@tiptap/extension-bubble-menu";
import { Bold, Code, Italic, List, ListChecks, Quote, SquareCode } from "lucide-react";
import { openExternalLink } from "@/lib/tauri-api";
import { ticketEditorExtensions } from "@/modules/tasks/editor/ticket-editor-extensions";
import { markdownToHtml } from "@/modules/tasks/editor/ticket-markdown";
import {
  editorCodec,
  snapshotSection,
  spliceSection,
  type SectionSnapshot,
} from "@/modules/tasks/editor/section-splice";

/**
 * One section of a vault ticket, editable in place — `bb`'s description editor
 * (`plugins/tasks/editor/tasks-editor.tsx`): a vanilla TipTap editor, always editable, no Edit
 * button, with a small bubble menu on a selection.
 *
 * What it hands up is not the editor's serialization but a SPLICE (`section-splice.ts`): every
 * block still equal to what the file said is the file's own text, byte for byte.
 *
 * Content from outside is only laid into the editor when `resetKey` changes — a reload, or the
 * file changing in Obsidian. A save coming back does NOT reset it: the person may have typed on
 * since, and a save must never move their cursor or eat what they typed.
 */

export interface TicketSectionEditorProps {
  body: string;
  /** Bumped when the text must be REPLACED (reload / outside change), not merely re-based. */
  resetKey: number;
  placeholder: string;
  onChange: (markdown: string) => void;
  onOpenReference?: (ref: string) => void;
  canOpenReference?: (ref: string) => boolean;
}

export function TicketSectionEditor({
  body,
  resetKey,
  placeholder,
  onChange,
  onOpenReference,
  canOpenReference,
}: TicketSectionEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const snapshotRef = useRef<SectionSnapshot | null>(null);
  // The latest callbacks, read by handlers the editor captured once at mount.
  const handlers = useRef({ onChange, onOpenReference, canOpenReference });
  handlers.current = { onChange, onOpenReference, canOpenReference };
  const [, setTick] = useState(0);

  // Mount once.
  useEffect(() => {
    const host = hostRef.current;
    const menu = menuRef.current;
    if (!host || !menu) return;

    const editor = new Editor({
      element: host,
      extensions: [
        ...ticketEditorExtensions(placeholder),
        BubbleMenu.configure({
          element: menu,
          updateDelay: 150,
          shouldShow: ({ editor: current, state }) => current.isEditable && !state.selection.empty,
        }),
      ],
      content: markdownToHtml(body),
      editorProps: {
        attributes: { class: "tk-markdown tk-editor", spellcheck: "true" },
        // ⌘/Ctrl-click follows a link or a [[reference]]; a plain click edits, as in `bb`.
        handleClickOn: (_view, _pos, node, _nodePos, event) => {
          if (!(event.metaKey || event.ctrlKey)) return false;
          if (node.type.name === "wikiLink") {
            const ref = String(node.attrs.target);
            const { onOpenReference: open, canOpenReference: can } = handlers.current;
            if (open && (can?.(ref) ?? true)) open(ref);
            return true;
          }
          return false;
        },
        handleClick: (view, pos, event) => {
          if (!(event.metaKey || event.ctrlKey)) return false;
          const link = view.state.doc.resolve(pos).marks().find((mark) => mark.type.name === "link");
          const href = link?.attrs.href as string | undefined;
          if (href && /^(https?:|mailto:)/i.test(href)) {
            void openExternalLink(href);
            return true;
          }
          return false;
        },
      },
      onUpdate: ({ editor: current }) => {
        const snapshot = snapshotRef.current;
        if (!snapshot) return;
        const { serialize } = editorCodec(current);
        handlers.current.onChange(spliceSection(snapshot, current.getJSON().content ?? [], serialize));
      },
      onSelectionUpdate: () => setTick((value) => value + 1),
    });
    editorRef.current = editor;
    snapshotRef.current = snapshotSection(body, editorCodec(editor).parse);

    return () => {
      editor.destroy();
      editorRef.current = null;
    };
    // Mounted once on purpose; `body` and `resetKey` are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A save came back: the file's text for this section is now `body`. Re-base the splice on it,
  // leave the editor — and the caret — alone.
  useEffect(() => {
    const editor = editorRef.current;
    if (editor) snapshotRef.current = snapshotSection(body, editorCodec(editor).parse);
  }, [body]);

  // Replaced from outside: lay the new text in.
  const lastReset = useRef(resetKey);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || lastReset.current === resetKey) return;
    lastReset.current = resetKey;
    editor.commands.setContent(markdownToHtml(body), { emitUpdate: false });
    snapshotRef.current = snapshotSection(body, editorCodec(editor).parse);
  }, [body, resetKey]);

  const editor = editorRef.current;
  const run = (action: (chain: ReturnType<Editor["chain"]>) => ReturnType<Editor["chain"]>) => {
    if (editor) action(editor.chain().focus()).run();
  };
  const active = (name: string) => Boolean(editor?.isActive(name));

  return (
    <>
      <div ref={hostRef} className="tk-editor-host" />
      {/* The bubble menu `bb` offers, minus H2: a `## ` inside a section would start a new one. */}
      <div ref={menuRef} className="tk-bubble" role="toolbar" aria-label="Format">
        <BubbleButton label="Bold" active={active("bold")} onClick={() => run((c) => c.toggleBold())}>
          <Bold size={14} strokeWidth={2} />
        </BubbleButton>
        <BubbleButton label="Italic" active={active("italic")} onClick={() => run((c) => c.toggleItalic())}>
          <Italic size={14} strokeWidth={2} />
        </BubbleButton>
        <BubbleButton label="Code" active={active("code")} onClick={() => run((c) => c.toggleCode())}>
          <Code size={14} strokeWidth={2} />
        </BubbleButton>
        <span className="tk-bubble-sep" aria-hidden />
        <BubbleButton
          label="Heading"
          active={Boolean(editor?.isActive("heading", { level: 3 }))}
          onClick={() => run((c) => c.toggleHeading({ level: 3 }))}
        >
          <span className="tk-bubble-text">H3</span>
        </BubbleButton>
        <BubbleButton label="Bullet list" active={active("bulletList")} onClick={() => run((c) => c.toggleBulletList())}>
          <List size={14} strokeWidth={2} />
        </BubbleButton>
        <BubbleButton label="Checklist" active={active("taskList")} onClick={() => run((c) => c.toggleTaskList())}>
          <ListChecks size={14} strokeWidth={2} />
        </BubbleButton>
        <BubbleButton label="Code block" active={active("codeBlock")} onClick={() => run((c) => c.toggleCodeBlock())}>
          <SquareCode size={14} strokeWidth={2} />
        </BubbleButton>
        <BubbleButton label="Quote" active={active("blockquote")} onClick={() => run((c) => c.toggleBlockquote())}>
          <Quote size={14} strokeWidth={2} />
        </BubbleButton>
      </div>
    </>
  );
}

function BubbleButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="tk-bubble-button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      // Keep the selection: a mousedown on the button would otherwise blur the editor first.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

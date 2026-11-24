"use client";
import { forwardRef, useImperativeHandle, useState } from "react";
import type { ReactNode } from "react";
import { Extension, type Range } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import Suggestion, { type SuggestionProps, type SuggestionKeyDownProps } from "@tiptap/suggestion";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { Heading1, Heading2, List, ListChecks, Text } from "lucide-react";
import { acquireCanvasOcclusion } from "../../../services/canvas-occlusion-store";

/** One block-insertion command surfaced in the `/` menu. */
export interface SlashItem {
  id: string;
  title: string;
  subtitle: string;
  keywords: string[];
  icon: ReactNode;
  run: (editor: Editor, range: Range) => void;
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    id: "paragraph",
    title: "Text",
    subtitle: "Plain paragraph",
    keywords: ["text", "paragraph", "body", "p"],
    icon: <Text size={15} aria-hidden />,
    run: (editor, range) => editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    id: "heading-1",
    title: "Heading 1",
    subtitle: "Large section title",
    keywords: ["heading", "title", "h1", "big"],
    icon: <Heading1 size={16} aria-hidden />,
    run: (editor, range) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 1 }).run(),
  },
  {
    id: "heading-2",
    title: "Heading 2",
    subtitle: "Medium subsection",
    keywords: ["heading", "subtitle", "h2"],
    icon: <Heading2 size={15} aria-hidden />,
    run: (editor, range) => editor.chain().focus().deleteRange(range).setNode("heading", { level: 2 }).run(),
  },
  {
    id: "bullet-list",
    title: "Bullet list",
    subtitle: "Simple bulleted list",
    keywords: ["bullet", "list", "unordered", "ul"],
    icon: <List size={15} aria-hidden />,
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    id: "task-list",
    title: "Checklist",
    subtitle: "Track to-dos with checkboxes",
    keywords: ["task", "todo", "check", "checklist", "checkbox"],
    icon: <ListChecks size={15} aria-hidden />,
    run: (editor, range) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
];

/** Pure filter so the command palette is unit-testable without a live editor. */
export function filterSlashItems(query: string, items: SlashItem[] = SLASH_ITEMS): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (item) => item.title.toLowerCase().includes(q) || item.keywords.some((k) => k.includes(q)),
  );
}

interface SlashMenuProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
}

export interface SlashMenuRef {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

const SlashCommandMenu = forwardRef<SlashMenuRef, SlashMenuProps>(function SlashCommandMenu(
  { items, command },
  ref,
) {
  const [selected, setSelected] = useState(0);
  // Reset the highlight to the top whenever the filtered list changes (canonical
  // "adjust state while rendering" pattern — avoids a cascading effect).
  const [seenItems, setSeenItems] = useState(items);
  if (seenItems !== items) {
    setSeenItems(items);
    setSelected(0);
  }

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: ({ event }) => {
        if (!items.length) return false;
        if (event.key === "ArrowDown") {
          setSelected((s) => (s + 1) % items.length);
          return true;
        }
        if (event.key === "ArrowUp") {
          setSelected((s) => (s + items.length - 1) % items.length);
          return true;
        }
        if (event.key === "Enter") {
          const item = items[selected];
          if (item) command(item);
          return true;
        }
        return false;
      },
    }),
    [items, selected, command],
  );

  if (!items.length) return null;
  return (
    // preventDefault on mousedown keeps the editor selection alive so deleteRange() targets the slash text.
    <div className="canvas-note-slash-menu nodrag" role="listbox" aria-label="Insert block" onMouseDown={(e) => e.preventDefault()}>
      <div className="canvas-note-slash-group" aria-hidden>Basic blocks</div>
      {items.map((item, i) => (
        <button
          key={item.id}
          type="button"
          role="option"
          aria-selected={i === selected}
          className={`canvas-note-slash-item${i === selected ? " is-active" : ""}`}
          onMouseEnter={() => setSelected(i)}
          onClick={() => command(item)}
        >
          <span className="canvas-note-slash-item-icon">{item.icon}</span>
          <span className="canvas-note-slash-item-text">
            <span className="canvas-note-slash-item-title">{item.title}</span>
            <span className="canvas-note-slash-item-sub">{item.subtitle}</span>
          </span>
          <span className="canvas-note-slash-item-key" aria-hidden>↵</span>
        </button>
      ))}
    </div>
  );
});

function positionMenu(element: HTMLElement, clientRect: (() => DOMRect | null) | null | undefined) {
  if (!clientRect) return;
  const rect = clientRect();
  if (!rect) return;
  const virtual = { getBoundingClientRect: () => rect };
  void computePosition(virtual, element, {
    placement: "bottom-start",
    strategy: "fixed",
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
  }).then(({ x, y }) => {
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
  });
}

/**
 * Notion-style `/` block-insertion menu. Built on @tiptap/suggestion; the popup is a
 * ReactRenderer mounted on <body> and positioned in viewport coords via floating-ui, so
 * it survives the ReactFlow canvas transform without clipping.
 */
export const SlashCommand = Extension.create({
  name: "slashCommand",
  addOptions() {
    return {
      suggestion: {
        char: "/",
        startOfLine: false,
        command: ({ editor, range, props }: { editor: Editor; range: Range; props: SlashItem }) => {
          props.run(editor, range);
        },
        items: ({ query }: { query: string }) => filterSlashItems(query),
        render: () => {
          let renderer: ReactRenderer<SlashMenuRef, SlashMenuProps> | null = null;
          // The menu is mounted on <body> at a fixed viewport position, floating
          // over the canvas — a native browser WebView would clip it. Hold an
          // occlusion lock for the menu's lifetime so the WebView parks beneath it.
          let releaseOcclusion: (() => void) | null = null;
          const dropOcclusion = () => {
            releaseOcclusion?.();
            releaseOcclusion = null;
          };

          return {
            onStart: (props: SuggestionProps<SlashItem>) => {
              renderer = new ReactRenderer(SlashCommandMenu, {
                editor: props.editor,
                props: { items: props.items, command: props.command },
              });
              releaseOcclusion = acquireCanvasOcclusion("note-slash-menu");
              const el = renderer.element as HTMLElement;
              el.style.position = "fixed";
              el.style.zIndex = "60";
              // Mount inside the canvas shell, not <body>: every canvas colour token
              // (--canvas-text, --canvas-surface, --canvas-node-note …) is scoped to
              // .codecanvas-shell, so a body-mounted menu cannot follow the active theme and has
              // to hard-code its palette. The shell sets no transform/filter/contain, so
              // `position: fixed` still resolves against the viewport exactly as before.
              (document.querySelector(".codecanvas-shell") ?? document.body).appendChild(el);
              positionMenu(el, props.clientRect);
            },
            onUpdate: (props: SuggestionProps<SlashItem>) => {
              renderer?.updateProps({ items: props.items, command: props.command });
              if (renderer) positionMenu(renderer.element as HTMLElement, props.clientRect);
            },
            onKeyDown: (props: SuggestionKeyDownProps) => {
              if (props.event.key === "Escape") {
                renderer?.destroy();
                renderer?.element.remove();
                renderer = null;
                dropOcclusion();
                return true;
              }
              return renderer?.ref?.onKeyDown(props) ?? false;
            },
            onExit: () => {
              renderer?.element.remove();
              renderer?.destroy();
              renderer = null;
              dropOcclusion();
            },
          };
        },
      },
    };
  },
  addProseMirrorPlugins() {
    return [Suggestion({ editor: this.editor, ...this.options.suggestion })];
  },
});

import { Node, mergeAttributes, textblockTypeInputRule, Extension, type AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Heading from "@tiptap/extension-heading";
import Placeholder from "@tiptap/extension-placeholder";
import { Table, TableRow, TableCell, TableHeader } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";

export { wikiToHtml } from "@/modules/tasks/editor/ticket-markdown";

/**
 * The editor's schema — the set `bb` uses for its task description (`plugins/tasks/editor/
 * extensions.ts`), on TipTap 3 like the rest of this app, plus what a vault needs and `bb` does
 * not: Obsidian's `[[links]]`, headings that cannot restructure a ticket, and lists that
 * remember whether they were tight. Markdown in and out is `ticket-markdown.ts`.
 */

/**
 * `[[target]]` / `[[target|alias]]`, kept as ONE atom so it survives the round trip — as plain
 * text the serializer would escape it to `\[\[TKT-836\]\]`, which Obsidian no longer links.
 */
export const WikiLink = Node.create({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      target: { default: "", parseHTML: (el) => el.getAttribute("data-wiki") ?? "" },
      alias: { default: null, parseHTML: (el) => el.getAttribute("data-alias") },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-wiki]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-wiki": node.attrs.target, class: "tk-md-ref" }),
      node.attrs.alias || node.attrs.target,
    ];
  },
});

/**
 * Headings the editor READS at every level but lets a person MAKE only at 3 and 4. A typed `## `
 * would write a line the reader cuts as a NEW section, and `# ` in the preamble would be taken
 * for the title (the Rust side refuses a `## ` body too).
 */
const SectionHeading = Heading.extend({
  addInputRules() {
    return (this.options.levels as number[])
      .filter((level) => level >= 3)
      .map((level) =>
        textblockTypeInputRule({ find: new RegExp(`^(#{${level}})\\s$`), type: this.type, getAttributes: { level } }),
      );
  },
  addKeyboardShortcuts() {
    return Object.fromEntries(
      (this.options.levels as number[])
        .filter((level) => level >= 3)
        .map((level) => [`Mod-Alt-${level}`, () => this.editor.commands.toggleHeading({ level: level as 3 | 4 })]),
    );
  },
});

/**
 * `tight` on every list type. markdown-it renders a tight list's items WITHOUT `<p>` wrappers,
 * which is what this reads, and the serializer writes blank lines between items only for a loose
 * one — so ticking one box in `- [ ] a\n- [ ] b` does not space the whole checklist out.
 */
const ListTightness = Extension.create({
  name: "listTightness",
  addGlobalAttributes() {
    return [
      {
        types: ["bulletList", "orderedList", "taskList"],
        attributes: {
          tight: {
            default: true,
            parseHTML: (element: HTMLElement) =>
              !Array.from(element.children).some((item) => item.querySelector(":scope > p")),
            renderHTML: (attributes: { tight?: boolean }) => ({ "data-tight": attributes.tight ? "true" : "false" }),
          },
        },
      },
    ];
  },
});

export function ticketEditorExtensions(placeholder: string): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: false,
      // Markdown has no underline, and a trailing empty paragraph would read as a change.
      underline: false,
      trailingNode: false,
      link: { openOnClick: false, autolink: true },
    }),
    SectionHeading.configure({ levels: [1, 2, 3, 4] }),
    Placeholder.configure({ placeholder }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({ nested: true }),
    ListTightness,
    WikiLink,
  ];
}

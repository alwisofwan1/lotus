import { EMPTY_BLOCK } from "@/modules/tasks/services/notion-markdown";

/**
 * Notion blocks that plain markdown has no word for, drawn the way Notion draws them (2026-09-29,
 * from Alwi's side-by-side of TKT-996). A rehype plugin for `TaskMarkdown`, acting only on the
 * markers `cleanNotionMarkdown` leaves — any other page draws exactly as before:
 *
 * - a quote whose first line is `[!callout] <icon> <colour>` → a tinted box with the icon;
 * - a paragraph that is only `EMPTY_BLOCK` → the empty space Notion leaves;
 * - a to-do with no text → Notion's grey "To-do" placeholder beside the box.
 */

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const CALLOUT = /^\[!callout\]\s*(\S+)?\s*(\S+)?\s*$/;

export function rehypeNotionBlocks() {
  return (tree: HastNode) => walk(tree);
}

function walk(node: HastNode): void {
  for (const child of node.children ?? []) {
    if (child.type !== "element") continue;
    if (child.tagName === "blockquote") callout(child);
    else if (child.tagName === "p" && textOf(child) === EMPTY_BLOCK) {
      child.tagName = "div";
      child.properties = { className: ["tk-md-gap"], ariaHidden: "true" };
      child.children = [];
    } else if (child.tagName === "li" && classes(child).includes("task-list-item")) emptyTodo(child);
    walk(child);
  }
}

function callout(quote: HastNode): void {
  const paragraphs = (quote.children ?? []).filter((c) => c.type === "element");
  const head = paragraphs[0];
  const match = head?.tagName === "p" ? CALLOUT.exec(textOf(head).trim()) : null;
  if (!head || !match) return;
  const [, icon, color] = match;
  quote.tagName = "div";
  quote.properties = { className: ["tk-md-callout"], dataColor: color ?? "default" };
  quote.children = [
    ...(icon ? [{ type: "element", tagName: "span", properties: { className: ["tk-md-callout-icon"], ariaHidden: "true" }, children: [{ type: "text", value: icon }] }] : []),
    { type: "element", tagName: "div", properties: { className: ["tk-md-callout-body"] }, children: (quote.children ?? []).filter((c) => c !== head) },
  ];
}

function emptyTodo(item: HastNode): void {
  const rest = (item.children ?? []).filter((c) => !(c.type === "element" && c.tagName === "input"));
  if (rest.some((c) => c.type !== "text" || (c.value ?? "").replace(/[\s ]/g, ""))) return;
  item.children = [
    ...(item.children ?? []).filter((c) => c.type === "element" && c.tagName === "input"),
    { type: "text", value: " " },
    { type: "element", tagName: "span", properties: { className: ["tk-md-todo-empty"] }, children: [{ type: "text", value: "To-do" }] },
  ];
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

function classes(node: HastNode): string[] {
  const value = node.properties?.className;
  return Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(" ") : [];
}

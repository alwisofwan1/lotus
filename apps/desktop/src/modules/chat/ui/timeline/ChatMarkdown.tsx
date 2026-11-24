"use client";

import { Check, ChevronDown, Copy, SquareArrowOutUpRight } from "lucide-react";
import { memo, useContext, useEffect, useRef, useState, type AnchorHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { copyTextToClipboard } from "@/lib/clipboard";
import { openExternalLink } from "@/lib/tauri-api";

import { holdTableHead, splitStreamingMarkdown } from "../../domain/streaming-markdown";
import { FileLink, FileLinksContext, isPage, OutLink } from "../ChatFiles";

// A hast node, typed only as far as these plugins read it.
interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
}

const ALERTS: Record<string, string> = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };

// GitHub alerts: `> [!WARNING]` turns the quote into a tinted card titled with its kind.
function rehypeAlerts() {
  const visit = (node: HNode) => {
    node.children?.forEach(visit);
    if (node.tagName !== "blockquote") return;
    const first = node.children?.find((c) => c.type === "element");
    const text = first?.tagName === "p" ? first.children?.[0] : undefined;
    const m = text?.type === "text" ? /^\[!(note|tip|important|warning|caution)\][ \t]*\n?/i.exec(text.value ?? "") : null;
    if (!m || !text) return;
    const kind = m[1].toLowerCase();
    text.value = text.value!.slice(m[0].length);
    node.tagName = "div";
    node.properties = { className: ["chat-md-alert"], dataKind: kind };
    node.children!.unshift({ type: "element", tagName: "div", properties: { className: ["chat-md-alert-title"] }, children: [{ type: "text", value: ALERTS[kind] }] });
  };
  return visit;
}

const BLOCKS = new Set(["p", "ul", "ol", "li", "blockquote", "div", "h1", "h2", "h3", "h4", "h5", "h6"]);

// Streaming tail only: every word becomes its own span, so a new word mounts and fades in while the
// words already shown stay still (React keeps them by position). The block the text ends in gets
// the caret. Code and tables stay whole, and hold no caret: it would sit behind text past it.
function rehypeStreamWords() {
  const split = (node: HNode) => {
    if (!node.children || node.tagName === "pre" || node.tagName === "table") return;
    node.children = node.children.flatMap((child): HNode[] => {
      if (child.type !== "text") {
        split(child);
        return [child];
      }
      return (child.value ?? "").split(/(\s+)/).filter(Boolean).map((part) =>
        /^\s+$/.test(part)
          ? { type: "text", value: part }
          : { type: "element", tagName: "span", properties: { className: ["chat-w"] }, children: [{ type: "text", value: part }] },
      );
    });
  };
  return (tree: HNode) => {
    split(tree);
    let host: HNode | null = null;
    for (let node: HNode | undefined = tree; node; ) {
      const last: HNode | undefined = node.children?.filter((c) => c.type === "element").at(-1);
      if (!last || last.tagName === "pre" || last.tagName === "table") break;
      if (!BLOCKS.has(last.tagName ?? "")) {
        host = node;
        break;
      }
      host = last;
      node = last;
    }
    if (host && host !== tree) {
      const names = host.properties?.className;
      host.properties = { ...host.properties, className: [...(Array.isArray(names) ? names : []), "chat-caret"] };
    }
  };
}

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeAlerts, rehypeHighlight];
// The live tail skips highlighting: it re-parses every frame, and code colours in once it settles.
const STREAM_PLUGINS = [rehypeAlerts, rehypeStreamWords];

/** Lines a code block shows before it folds. */
// `open path/to/page.html` in a shell block: the file gets a button in the block's header.
const OPEN_COMMAND = /^\s*(?:\$\s*)?open\s+(?:-a\s+\S+\s+)?["']?([^\s"']+)["']?\s*$/gm;

const FOLD_LINES = 14;

function hastText(node: HNode): string {
  return node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(hastText).join("");
}

function CodeBlock({ node, children }: { node?: HNode; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const code = node?.children?.find((c) => c.tagName === "code");
  const names = code?.properties?.className;
  const lang = (Array.isArray(names) ? names : []).map(String).find((n) => n.startsWith("language-"))?.slice(9);
  const text = node ? hastText(node).replace(/\n$/, "") : "";
  const lines = text.split("\n").length;
  const long = lines > FOLD_LINES;
  const opens = [...new Set(Array.from(text.matchAll(OPEN_COMMAND), (m) => m[1]))];
  return (
    <div className="chat-md-code" data-long={long || undefined} data-open={open || undefined}>
      <div className="chat-md-code-head">
        <span className="chat-md-code-lang">{lang ?? "text"}</span>
        {opens.length > 0 && (
          <span className="chat-md-code-opens">
            {/* A path that is not one file in the chat's folder draws nothing. */}
            {opens.map((path) => (
              <FileLink key={path} text={path} fallback={<></>}>
                <span className="chat-md-code-open">
                  <SquareArrowOutUpRight size={11} aria-hidden />
                  {path.slice(path.lastIndexOf("/") + 1)}
                </span>
              </FileLink>
            ))}
          </span>
        )}
        <button
          type="button"
          className="chat-md-code-copy"
          data-done={copied || undefined}
          onClick={() => {
            void copyTextToClipboard(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            });
          }}
        >
          {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
      {long && (
        <div className="chat-md-code-more">
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
            <ChevronDown size={11} aria-hidden />
            {open ? "Show less" : `Show all ${lines} lines`}
          </button>
        </div>
      )}
    </div>
  );
}

// A plain link would navigate the whole Tauri window away from Lotus. A web page opens in Preview
// beside the chat, with a small button to take it to the browser; elsewhere it opens outside.
// `node` is react-markdown's AST handle and must not reach the DOM.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function MarkdownLink({ node, href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const browse = useContext(FileLinksContext)?.browse;
  const web = !!href && /^https?:/i.test(href);
  // `[PLAN.md](file:///repo/plans/PLAN.md)` names a file the same way a bare path does.
  const file = href && /^file:\/\//i.test(href) ? safeDecode(href.slice(7)) : null;
  const link = (
    <a
      {...rest}
      href={href}
      title={web && browse ? `Open ${href} in Lotus` : href}
      onClick={(event) => {
        event.preventDefault();
        if (web && browse) browse(href);
        else if (file && browse && isPage(file)) browse(href!);
        else if (href && /^(https?:|mailto:)/i.test(href)) void openExternalLink(href);
      }}
    >
      {children}
    </a>
  );
  if (web && browse) {
    return (
      <span className="chat-link-pair">
        {link}
        <OutLink label="Open in your browser" onOpen={() => void openExternalLink(href)} />
      </span>
    );
  }
  // A relative link (`[form](src/LoginForm.tsx#L21)`) opens the file in the Files pane (#282).
  if (!href || (!file && /^[a-z][\w+.-]*:/i.test(href))) return link;
  return (
    <FileLink text={file ?? safeDecode(href)} fallback={link}>
      {children}
    </FileLink>
  );
}

const COMPONENTS: Components = {
  a: MarkdownLink,
  // Inline code that names a file in the chat's folder is a link to it; blocks stay code.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  code: ({ node, className, children, ...rest }: HTMLAttributes<HTMLElement> & { node?: unknown }) => {
    const code = (
      <code className={className} {...rest}>
        {children}
      </code>
    );
    if (className || typeof children !== "string" || children.includes("\n")) return code;
    return <FileLink text={children}>{code}</FileLink>;
  },
  pre: ({ node, children }) => <CodeBlock node={node as HNode | undefined}>{children}</CodeBlock>,
  table: ({ children }) => <TableScroll>{children}</TableScroll>,
};

/** A table wider than the chat scrolls sideways; the edge with more columns past it fades. */
function TableScroll({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    const mark = () => {
      const { scrollLeft: left, scrollWidth: width, clientWidth: shown } = box;
      box.toggleAttribute("data-more-left", left > 1);
      box.toggleAttribute("data-more-right", left + shown < width - 1);
    };
    mark();
    box.addEventListener("scroll", mark, { passive: true });
    // Rows streaming in and the pane resizing both change whether it overflows
    const seen = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(mark);
    seen?.observe(box);
    if (box.firstElementChild) seen?.observe(box.firstElementChild);
    return () => {
      box.removeEventListener("scroll", mark);
      seen?.disconnect();
    };
  }, []);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const table = ref.current?.querySelector("table");
    if (!table) return;
    void copyTextToClipboard(tableTsv(table)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  return (
    <div className="chat-md-table-wrap">
      <div ref={ref} className="chat-md-table">
        <table>{children}</table>
      </div>
      <button
        type="button"
        className="chat-md-code-copy chat-md-table-copy"
        data-done={copied || undefined}
        aria-label={copied ? "Copied" : "Copy table"}
        title="Copy table — pastes as a table into Sheets or Notion"
        onClick={copy}
      >
        {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
      </button>
    </div>
  );
}

/** Tab-separated rows: spreadsheets and Notion paste it as a table, and it reads fine as text. */
export function tableTsv(table: HTMLTableElement): string {
  return Array.from(table.rows, (row) =>
    Array.from(row.cells, (cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()).join("\t"),
  ).join("\n");
}

function safeDecode(href: string): string {
  try {
    return decodeURI(href);
  } catch {
    return href;
  }
}

// The default drops `file:` hrefs to "", which left a file link dead; MarkdownLink handles them.
const urlTransform = (url: string) => (/^file:\/\//i.test(url) ? url : defaultUrlTransform(url));

// Raw HTML in the text stays text: react-markdown draws no markup from the model.
const MarkdownBlock = memo(function MarkdownBlock({ text, live = false }: { text: string; live?: boolean }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={live ? STREAM_PLUGINS : REHYPE_PLUGINS} components={COMPONENTS} urlTransform={urlTransform}>
      {text}
    </ReactMarkdown>
  );
});

/**
 * Text arrives in bursts; this reveals it at a steady pace instead, a few characters a frame, faster
 * when it falls behind so it never lags far. It cuts at a space, so a half word or a half `**` never
 * shows. Text already there when the reply mounts shows at once.
 */
function useSmoothText(text: string): string {
  const [shown, setShown] = useState(text.length);
  const behind = shown < text.length;
  useEffect(() => {
    if (!behind) return;
    const frame = requestAnimationFrame(() =>
      setShown((n) => Math.min(text.length, n + Math.max(3, Math.ceil((text.length - n) / 12)))),
    );
    return () => cancelAnimationFrame(frame);
  }, [behind, shown, text.length]);
  if (!behind) return text;
  const cut = Math.max(text.lastIndexOf(" ", shown), text.lastIndexOf("\n", shown));
  return text.slice(0, cut > 0 ? cut : shown);
}

/** While streaming, the settled part is parsed once; only the tail re-parses per frame. */
export function ChatMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  const smooth = useSmoothText(text);
  const live = streaming || smooth !== text;
  const split = live ? splitStreamingMarkdown(smooth) : { settled: text, tail: "" };
  const settled = split.settled;
  const tail = live ? holdTableHead(split.tail) : "";
  return (
    <div className="chat-md" data-streaming={live || undefined}>
      {settled && <MarkdownBlock text={settled} />}
      {tail && <MarkdownBlock text={tail} live />}
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { editorMediaType } from "@/modules/codespace/services/editor-media";
import { resolveMarkdownPath } from "@/modules/codespace/services/markdown-links";

interface WorkbenchMarkdownPreviewProps {
  content: string;
  className?: string;
  metadata?: FrontmatterRow[];
  /**
   * Skill docs often use single-newline command cheat sheets. CommonMark treats
   * those as soft wraps, which collapses separate commands into one paragraph.
   */
  preserveSoftBreaks?: boolean;
  /**
   * The Markdown file shown, so relative images and links resolve from its folder. With
   * `loadFile` its images load from disk (locally or over SSH); with `onOpenFile` a link to a
   * file opens it in the editor.
   */
  filePath?: string | null;
  rootDir?: string | null;
  loadFile?: (path: string) => Promise<ArrayBuffer>;
  onOpenFile?: (path: string) => void;
}

type MarkdownAstNode = {
  type?: string;
  value?: string;
  children?: MarkdownAstNode[];
};

type FrontmatterRow = {
  key: string;
  value: string;
};

const REMARK_PLUGINS = [remarkGfm];
const REMARK_PLUGINS_WITH_SOFT_BREAKS = [remarkGfm, remarkPreserveSoftBreaks];
const REHYPE_PLUGINS = [rehypeHighlight];

function remarkPreserveSoftBreaks() {
  return (tree: MarkdownAstNode) => {
    splitTextSoftBreaks(tree);
  };
}

function splitTextSoftBreaks(node: MarkdownAstNode) {
  if (!node.children || node.type === "code" || node.type === "inlineCode" || node.type === "html") {
    return;
  }

  const preserveHere = node.type === "paragraph" && isCommandCheatSheetParagraph(node);

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];

    if (preserveHere && child.type === "text" && typeof child.value === "string" && child.value.includes("\n")) {
      const replacement = child.value.split("\n").flatMap((part, partIndex) => {
        const nodes: MarkdownAstNode[] = partIndex > 0 ? [{ type: "break" }] : [];
        if (part.length > 0) nodes.push({ ...child, value: part });
        return nodes;
      });
      node.children.splice(index, 1, ...replacement);
      index += replacement.length - 1;
      continue;
    }

    splitTextSoftBreaks(child);
  }
}

function isCommandCheatSheetParagraph(node: MarkdownAstNode): boolean {
  const text = extractAstText(node);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return false;

  const commandLikeLines = lines.filter((line) =>
    /`[^`]+`/.test(line) ||
    /^\/[\w.-]+/.test(line) ||
    /(?:^|\s)--?[\w-]+/.test(line) ||
    /\s#\s/.test(line),
  );

  return commandLikeLines.length >= Math.ceil(lines.length * 0.6);
}

function extractAstText(node: MarkdownAstNode): string {
  if (typeof node.value === "string") return node.value;
  return node.children?.map(extractAstText).join("") ?? "";
}

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const rawText = extractText(children).trimEnd();
  const lang = getCodeBlockLanguage(children);
  const label = lang || "code";

  const handleCopy = () => {
    const clipboard = navigator.clipboard;
    if (!clipboard) return;

    void clipboard.writeText(rawText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }).catch(() => undefined);
  };

  return (
    <div className="wbmd-code-block">
      <div className="wbmd-code-toolbar">
        <span className="wbmd-code-lang">{label}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="wbmd-code-copy"
          aria-label={copied ? "Code copied" : "Copy code"}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="wbmd-pre">{children}</pre>
    </div>
  );
}

function getCodeBlockLanguage(node: React.ReactNode): string {
  if (Array.isArray(node)) {
    return node.map(getCodeBlockLanguage).find(Boolean) ?? "";
  }

  if (node !== null && typeof node === "object" && "props" in node) {
    const className = String((node as { props: { className?: string } }).props.className ?? "");
    return className.match(/language-([\w-]+)/)?.[1] ?? "";
  }

  return "";
}

function extractText(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return (node as React.ReactNode[]).map(extractText).join("");
  if (node !== null && typeof node === "object" && "props" in node) {
    const el = node as { props: { children?: React.ReactNode } };
    return extractText(el.props.children ?? null);
  }
  return "";
}

function stripExecutableHtml(content: string): string {
  return content.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

function parseMarkdownFrontmatter(content: string): { body: string; frontmatter: FrontmatterRow[] } {
  const match = content.match(/^\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { body: content, frontmatter: [] };

  return {
    body: content.slice(match[0].length).trimStart(),
    frontmatter: parseFrontmatterRows(match[1]),
  };
}

function parseFrontmatterRows(source: string): FrontmatterRow[] {
  const rows: FrontmatterRow[] = [];
  let current: FrontmatterRow | null = null;

  for (const rawLine of source.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;

    const keyValue = rawLine.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (keyValue) {
      current = { key: keyValue[1], value: cleanFrontmatterValue(keyValue[2]) };
      rows.push(current);
      continue;
    }

    if (current && /^\s+/.test(rawLine)) {
      const nextValue = cleanFrontmatterValue(rawLine.trim());
      if (nextValue) current.value = [current.value, nextValue].filter(Boolean).join(" ");
    }
  }

  return rows.filter((row) => row.value.length > 0);
}

function cleanFrontmatterValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "|" || trimmed === ">") return "";
  return trimmed.replace(/^['"]|['"]$/g, "");
}

/** An image from the disk: read as bytes, shown from a Blob (the webview cannot load a file path). */
function DiskImage({ path, alt, title, load }: { path: string; alt: string; title?: string; load: (path: string) => Promise<ArrayBuffer> }) {
  const [state, setState] = useState<{ path: string; url: string | null; failed: boolean }>({ path, url: null, failed: false });
  const media = editorMediaType(path);
  const mime = media?.kind === "image" ? media.mime : null;
  useEffect(() => {
    if (!mime) return;
    let cancelled = false;
    let url: string | null = null;
    load(path).then(
      (bytes) => {
        if (cancelled) return;
        url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        setState({ path, url, failed: false });
      },
      () => {
        if (!cancelled) setState({ path, url: null, failed: true });
      },
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [load, mime, path]);
  const current = !mime ? { url: null, failed: true } : state.path === path ? state : { url: null, failed: false };
  if (current.failed) {
    return <span className="wbmd-image-missing" title={path}>{alt || path.split("/").pop()}</span>;
  }
  if (!current.url) return <span className="wbmd-image-loading" aria-label={alt || "Loading image"} />;
  // eslint-disable-next-line @next/next/no-img-element -- a local Blob, not an optimizable asset
  return <img src={current.url} alt={alt} title={title} className="wbmd-image" />;
}

export function WorkbenchMarkdownPreview({
  content,
  className,
  metadata,
  preserveSoftBreaks = false,
  filePath = null,
  rootDir = null,
  loadFile,
  onOpenFile,
}: WorkbenchMarkdownPreviewProps) {
  const safeContent = stripExecutableHtml(content);
  const { body, frontmatter: parsedFrontmatter } = parseMarkdownFrontmatter(safeContent);
  const frontmatter = metadata && metadata.length > 0 ? metadata : parsedFrontmatter;
  const remarkPlugins = preserveSoftBreaks ? REMARK_PLUGINS_WITH_SOFT_BREAKS : REMARK_PLUGINS;
  // Callers pass inline callbacks; read through refs so `components` stays one object. A new
  // object makes every code block, link and image a new component type, remounted on each render:
  // an image drops back to its loading box and the page jumps (Chat Files, every 15 s rail poll).
  const loadRef = useRef(loadFile);
  const openRef = useRef(onOpenFile);
  useEffect(() => {
    loadRef.current = loadFile;
    openRef.current = onOpenFile;
  });
  const canLoad = !!loadFile;
  const canOpen = !!onOpenFile;
  const components = useMemo<Components>(() => {
    const load = (path: string) => loadRef.current!(path);
    return {
            pre({ children }) {
              return <CodeBlock>{children}</CodeBlock>;
            },
            code({ className, children, ...props }) {
              return (
                <code className={cn("wbmd-inline-code", className)} {...props}>
                  {children}
                </code>
              );
            },
            a({ href, children }) {
              const local = href && filePath && canOpen ? resolveMarkdownPath(href, filePath, rootDir) : null;
              if (local) {
                return (
                  <a
                    href={href}
                    className="wbmd-link"
                    title={local}
                    onClick={(event) => {
                      event.preventDefault();
                      openRef.current?.(local);
                    }}
                  >
                    {children}
                  </a>
                );
              }
              return (
                <a href={href} target="_blank" rel="noreferrer" className="wbmd-link">
                  {children}
                </a>
              );
            },
            img({ src, alt, title }) {
              const source = typeof src === "string" ? src : "";
              const local = source && filePath && canLoad ? resolveMarkdownPath(source, filePath, rootDir) : null;
              if (local) return <DiskImage path={local} alt={alt ?? ""} title={title} load={load} />;
              // eslint-disable-next-line @next/next/no-img-element -- remote or inline Markdown image
              return <img src={source} alt={alt ?? ""} title={title} className="wbmd-image" />;
            },
            table({ children }) {
              return (
                <div className="wbmd-table-wrap" role="region" aria-label="Markdown table">
                  <table className="wbmd-table">{children}</table>
                </div>
              );
            },
            blockquote({ children }) {
              return <blockquote className="wbmd-blockquote">{children}</blockquote>;
            },
            hr() {
              return <hr className="wbmd-hr" />;
            },
    };
  }, [filePath, rootDir, canLoad, canOpen]);

  return (
    <div className={cn("wbmd-scroll min-h-0 flex-1 overflow-y-auto", className)}>
      <article className="wbmd-article">
        {frontmatter.length > 0 && <FrontmatterTable rows={frontmatter} />}
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={REHYPE_PLUGINS}
          components={components}
        >
          {body}
        </ReactMarkdown>
      </article>
    </div>
  );
}

function FrontmatterTable({ rows }: { rows: FrontmatterRow[] }) {
  return (
    <div className="wbmd-frontmatter" role="region" aria-label="Document metadata">
      <table className="wbmd-frontmatter-table">
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.key}</th>
              <td>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

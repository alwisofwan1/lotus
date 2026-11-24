"use client";
import { isValidElement, memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

function extractTextFromReactNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractTextFromReactNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractTextFromReactNode(node.props.children);
  }
  return "";
}

function getCodeBlockLanguage(node: ReactNode): string {
  if (Array.isArray(node)) {
    for (const child of node) {
      const lang = getCodeBlockLanguage(child);
      if (lang !== "text") return lang;
    }
    return "text";
  }
  if (!isValidElement<{ className?: string }>(node)) return "text";
  const cls = node.props.className ?? "";
  return /language-([a-z0-9_+-]+)/i.exec(cls)?.[1] ?? "text";
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to execCommand fallback
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.top = "-9999px";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    el.remove();
    return ok;
  } catch {
    return false;
  }
}

function AgentCodeBlock({ children }: { children: ReactNode }) {
  const text = extractTextFromReactNode(children).replace(/\n$/, "");
  const language = getCodeBlockLanguage(children);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const handleCopy = async () => {
    const ok = await copyToClipboard(text);
    setCopyState(ok ? "copied" : "failed");
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopyState("idle"), 1800);
  };

  const copyLabel =
    copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy";

  return (
    <div className="agent-md-codeblock">
      <div className="agent-md-codeblock-toolbar">
        <span className="agent-md-codeblock-language">{language}</span>
        <button
          type="button"
          className={`agent-md-codeblock-copy${copyState === "copied" ? " agent-md-codeblock-copy--copied" : ""}`}
          onClick={() => void handleCopy()}
          aria-label="Copy code"
          title="Copy code"
        >
          {copyState === "copied" ? (
            <Check size={10} aria-hidden />
          ) : (
            <Copy size={10} aria-hidden />
          )}
          <span>{copyLabel}</span>
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

export const AgentMarkdownBlock = memo(function AgentMarkdownBlock({ text }: { text: string }) {
  return (
    <div className="agent-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <AgentCodeBlock>{children}</AgentCodeBlock>,
          table: ({ children }) => (
            <div className="agent-md-table-wrap" role="region" aria-label="Table">
              <table>{children}</table>
            </div>
          ),
          a: ({ href, children, ...rest }) => (
            <a href={href} target="_blank" rel="noreferrer noopener" {...rest}>
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

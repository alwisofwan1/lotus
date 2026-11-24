"use client";

import { memo, useMemo, type AnchorHTMLAttributes, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { openExternalLink } from "@/lib/tauri-api";
import { WIKI_HREF_PREFIX, linkWikiReferences, wikiTarget } from "@/modules/tasks/services/wiki-links";
import { rehypeNotionBlocks } from "@/modules/tasks/services/notion-blocks";

/** Notion's callouts, empty blocks and empty to-dos; a no-op on any page without their markers. */
const REHYPE_PLUGINS = [rehypeNotionBlocks];

/**
 * GitHub's HTML (LOT2-107): `<details>`, `<img>`, `<kbd>`, `<sub>`… drawn, then cleaned by
 * rehype-sanitize's default schema — GitHub's own allowlist — so no script, style, iframe, form,
 * event handler or `javascript:` URL survives. Sanitize runs last: nothing after it adds markup.
 */
const GITHUB_REHYPE_PLUGINS = [rehypeRaw, rehypeSanitize];

/** Raw HTML that is only comments: `<!-- … -->`, one or several. */
const ONLY_COMMENTS = /^\s*(?:<!--[\s\S]*?-->\s*)+$/;

type MdNode = { type: string; value?: string; children?: MdNode[] };

/**
 * Drops HTML comments before they are drawn. Raw HTML is shown as text here (no markup from these
 * words), which would print a comment that GitHub and Obsidian both hide — a bot's
 * `<!-- gh-aw-workflow-call-id: … -->` footer, a template's `<!-- Gather before planning -->`.
 * Only whole comments go; code keeps its text, and any other HTML still shows as text.
 */
function remarkDropHtmlComments() {
  const prune = (node: MdNode) => {
    if (!node.children) return;
    node.children = node.children.filter((child) => !(child.type === "html" && ONLY_COMMENTS.test(child.value ?? "")));
    node.children.forEach(prune);
  };
  return prune;
}

const REMARK_PLUGINS = [remarkGfm, remarkDropHtmlComments];

/**
 * The one markdown reader for the tracker — a task's brief and a vault ticket's sections.
 *
 * GFM, because the briefs lean on tables, task lists and fenced code. No raw HTML: these words
 * come from agents and from pasted Notion pages, and nothing in them should be able to put markup
 * in the page. The one exception is GitHub's own allowlist, for GitHub issues (`html="github"`).
 *
 * Links open OUTSIDE the app. This is a Tauri webview: a plain `<a href>` navigates the whole
 * window away from Lotus, and there is no back button to return with.
 *
 * Obsidian `[[links]]` are drawn as reference chips (`wiki-links.ts`). One that names a ticket the
 * tracker holds opens it in place; any other stays a chip that says what it points at.
 */

export interface TaskMarkdownProps {
  children: string;
  /** Open a `[[reference]]` inside the tracker. Absent: references are drawn but inert. */
  onOpenReference?: (ref: string) => void;
  /** Whether a reference names something `onOpenReference` can actually open. */
  canOpenReference?: (ref: string) => boolean;
  /**
   * `"github"`: draw the HTML GitHub allows, as GitHub does. Absent: raw HTML stays text — briefs
   * and Notion/Obsidian pages carry no markup of their own.
   */
  html?: "github";
}

/** react-markdown drops unknown schemes; ours is let through, everything else keeps the default. */
function urlTransform(url: string): string {
  return url.startsWith(WIKI_HREF_PREFIX) ? url : defaultUrlTransform(url);
}

/** Wide tables scroll inside their own box instead of widening the reading column. */
function ScrollingTable({ children }: { children?: ReactNode }) {
  return (
    <div className="tk-md-table">
      <table>{children}</table>
    </div>
  );
}

export const TaskMarkdown = memo(function TaskMarkdown({
  children,
  onOpenReference,
  canOpenReference,
  html,
}: TaskMarkdownProps) {
  const source = useMemo(() => linkWikiReferences(children), [children]);

  const components = useMemo<Components>(
    () => ({
      // `node` is react-markdown's AST handle; it must not reach the DOM as an attribute.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      a: ({ node, href, children: label, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => {
        const ref = wikiTarget(href);
        if (ref !== null) {
          const openable = Boolean(onOpenReference && (canOpenReference?.(ref) ?? true));
          return openable ? (
            <button type="button" className="tk-md-ref" data-openable="true" onClick={() => onOpenReference!(ref)}>
              {label}
            </button>
          ) : (
            <span className="tk-md-ref" title={`${ref} is not in this vault`}>
              {label}
            </span>
          );
        }
        const external = typeof href === "string" && /^(https?:|mailto:)/i.test(href);
        return (
          <a
            {...rest}
            href={href}
            title={href}
            onClick={(event) => {
              event.preventDefault();
              if (external) void openExternalLink(href!);
            }}
          >
            {label}
          </a>
        );
      },
      table: ({ children: rows }) => <ScrollingTable>{rows}</ScrollingTable>,
    }),
    [canOpenReference, onOpenReference],
  );

  return (
    <div className="tk-markdown">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={html === "github" ? GITHUB_REHYPE_PLUGINS : REHYPE_PLUGINS}
        components={components}
        urlTransform={urlTransform}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});

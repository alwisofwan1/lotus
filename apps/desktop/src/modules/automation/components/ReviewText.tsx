"use client";

import { memo, type AnchorHTMLAttributes } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { openExternalLink } from "@/lib/tauri-api";

/**
 * A review's words as GitHub will show them: GFM, no raw HTML (the text comes from an agent).
 * Links open outside the app; a plain `<a>` would navigate the Tauri window away from Lotus.
 */

const REMARK_PLUGINS = [remarkGfm];

const open = (href: unknown) => (event: { preventDefault: () => void }) => {
  event.preventDefault();
  if (typeof href === "string" && /^https?:/i.test(href)) void openExternalLink(href);
};

const COMPONENTS: Components = {
  // `node` is react-markdown's AST handle; it must not reach the DOM as an attribute.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  a: ({ node, href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => (
    <a {...rest} href={href} title={href} onClick={open(href)}>
      {children}
    </a>
  ),
};

/**
 * For text other people may have steered (a review's question, ADR-0040 §6): a link shows where it
 * goes, never words chosen to disguise it, and an image is a link too, so nothing loads by itself.
 */
const LITERAL_COMPONENTS: Components = {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  a: ({ node, href }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) => (
    <a href={href} title={href} onClick={open(href)}>
      {href}
    </a>
  ),
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  img: ({ node, src }: { node?: unknown; src?: unknown }) => {
    const href = typeof src === "string" ? src : "";
    return (
      <a href={href} title={href} onClick={open(href)}>
        {href}
      </a>
    );
  },
};

export const ReviewText = memo(function ReviewText({
  children,
  empty,
  literalLinks = false,
}: {
  children: string;
  empty?: string;
  /** Show every link's full URL and no image (see `LITERAL_COMPONENTS`). */
  literalLinks?: boolean;
}) {
  if (!children.trim()) return <p className="au-review-text au-review-text--empty">{empty ?? "Empty."}</p>;
  return (
    <div className="au-review-text">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={literalLinks ? LITERAL_COMPONENTS : COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
});

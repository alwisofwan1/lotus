/**
 * Generated, not hand-written, so the origin lives only in astro.config.mjs.
 *
 * Crawling is allowed but discovery is not the strategy: issues/01 accepted that a
 * search for "lotus" will never surface this product, and issues/06 planned a launch
 * that is 100% channel-driven. Search engines are welcome; they are simply not the
 * plan.
 */
import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) => {
  const body = [
    "User-agent: *",
    "Allow: /",
    "",
    `Sitemap: ${new URL("sitemap.xml", site).href}`,
    "",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};

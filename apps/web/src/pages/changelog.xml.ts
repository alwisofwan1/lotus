/**
 * RSS for the changelog, one item per release. Hand-rolled like the sitemap: one feed does
 * not earn @astrojs/rss as a dependency.
 */
import type { APIRoute } from "astro";
import { site } from "../copy";
import { releases } from "../lib/releases";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const GET: APIRoute = async ({ site: origin }) => {
  const page = new URL("/changelog/", origin).href;
  const items = await Promise.all(
    releases.map(async (r) => {
      const link = `${page}#v${r.version}`;
      return `  <item>
    <title>${esc(`${site.name} ${r.version}: ${r.title}`)}</title>
    <link>${link}</link>
    <guid isPermaLink="true">${link}</guid>
    <pubDate>${new Date(`${r.date}T12:00:00Z`).toUTCString()}</pubDate>
    <description>${esc(await r.html())}</description>
  </item>`;
    }),
  );
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${esc(`${site.name} releases`)}</title>
  <link>${page}</link>
  <description>${esc("Every Lotus release, newest first.")}</description>
${items.join("\n")}
</channel>
</rss>
`;
  return new Response(body, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
};

/**
 * Hand-rolled rather than @astrojs/sitemap: four URLs, and the integration would be
 * a dependency to maintain for four URLs. Revisit if /docs ever lands — that is still
 * fog in map.md.
 *
 * Add a page here when you add a route. A page missing from the sitemap is not an
 * error anywhere; it is simply never crawled. /404 is left out on purpose — it is
 * `noindex`, and a sitemap listing a noindex URL sends crawlers mixed signals.
 *
 * `lastmod` comes from the date each page already shows or keeps in copy.ts, so the
 * sitemap cannot claim a page changed on a day the page itself does not.
 */
import type { APIRoute } from "astro";
import { privacy, privacyDesktop, site } from "../copy";
import { releases } from "../lib/releases";

// Trailing slashes are not cosmetic here: Astro builds directory-format routes, so
// `/privacy/` is what `<link rel="canonical">` emits and `/privacy` merely 308s to it.
// A sitemap advertising the redirect makes crawlers take an extra hop to reach the
// URL the page itself claims is canonical.
const PAGES: readonly { path: string; lastmod: string }[] = [
  { path: "/", lastmod: site.updated },
  { path: "/changelog/", lastmod: releases[0].date },
  { path: "/privacy/", lastmod: privacy.updated },
  { path: "/privacy/desktop/", lastmod: privacyDesktop.updated },
];

export const GET: APIRoute = ({ site: origin }) => {
  const urls = PAGES.map(
    ({ path, lastmod }) => `  <url><loc>${new URL(path, origin).href}</loc><lastmod>${lastmod}</lastmod></url>`,
  ).join("\n");

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  return new Response(body, {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};

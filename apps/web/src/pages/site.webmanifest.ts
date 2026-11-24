/**
 * The web app manifest. Generated, like robots.txt and sitemap.xml, so the name,
 * description and colours come from copy.ts and cannot drift from the page.
 *
 * `display: "browser"` on purpose: this is a landing page, not an installable app.
 * The manifest is here for the icons and colours that Android, Chrome and link
 * previews read — not to offer "Install Lotus", which would install a web page
 * called Lotus next to a desktop app called Lotus.
 *
 * Icons are rendered by scripts/brand-icons.py.
 */
import type { APIRoute } from "astro";
import { site } from "../copy";

export const GET: APIRoute = () => {
  const manifest = {
    name: site.name,
    short_name: site.name,
    description: site.description,
    start_url: "/",
    scope: "/",
    display: "browser",
    background_color: site.themeColor,
    theme_color: site.themeColor,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };

  return new Response(`${JSON.stringify(manifest, null, 2)}\n`, {
    headers: { "Content-Type": "application/manifest+json; charset=utf-8" },
  });
};

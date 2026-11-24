/**
 * The built site's metadata, checked where it ships: in `dist/`, after a real build.
 *
 * Every tag here is invisible on the page, so nothing a person looks at catches a
 * missing one — a dropped `og:image` shows up weeks later as a blank card in someone
 * else's Slack. This builds once and reads the output files, so it tests what
 * Cloudflare will serve, not what the source seems to say.
 *
 * The JSON-LD block is held to the same forbidden-claims rules as copy.ts (see
 * `structuredData` there): nobody proofreads structured data, so a test has to.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { site } from "../src/copy";

const WEB = resolve(dirname(new URL(import.meta.url).pathname), "..");
const DIST = join(WEB, "dist");
const read = (rel: string) => readFileSync(join(DIST, rel), "utf8");

let HOME = "";

beforeAll(() => {
  execFileSync(join(WEB, "node_modules", ".bin", "astro"), ["build", "--silent"], { cwd: WEB, stdio: "pipe" });
  HOME = read("index.html");
}, 120_000);

/** The `content` of `<meta name|property="key">`, or undefined. */
function meta(html: string, key: string): string | undefined {
  const tag = html.match(new RegExp(`<meta[^>]*(?:name|property)="${key}"[^>]*>`))?.[0];
  return tag?.match(/content="([^"]*)"/)?.[1];
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(rel: string): [number, number] {
  const bytes = readFileSync(join(DIST, rel));
  expect(bytes.subarray(1, 4).toString("latin1"), `${rel} is not a PNG`).toBe("PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe("head tags", () => {
  const REQUIRED = [
    "description",
    "robots",
    "color-scheme",
    "theme-color",
    "og:type",
    "og:locale",
    "og:site_name",
    "og:url",
    "og:title",
    "og:description",
    "og:image",
    "og:image:type",
    "og:image:width",
    "og:image:height",
    "og:image:alt",
    "twitter:card",
    "twitter:title",
    "twitter:description",
    "twitter:image",
    "twitter:image:alt",
  ];

  for (const key of REQUIRED) {
    it(`the home page has ${key}`, () => {
      expect(meta(HOME, key), `<meta ${key}> is missing or empty in dist/index.html`).toBeTruthy();
    });
  }

  it("uses absolute URLs for the share image, as Open Graph requires", () => {
    expect(meta(HOME, "og:image")).toMatch(/^https:\/\/.+\/og\.png$/);
    expect(meta(HOME, "twitter:image")).toBe(meta(HOME, "og:image"));
  });

  it("describes the card with the same alt text in both vocabularies", () => {
    expect(meta(HOME, "og:image:alt")).toBe(site.ogImageAlt);
    expect(meta(HOME, "twitter:image:alt")).toBe(site.ogImageAlt);
  });

  it("links the manifest and every icon", () => {
    for (const rel of ['rel="manifest" href="/site.webmanifest"', 'rel="apple-touch-icon" href="/apple-touch-icon.png"', 'href="/favicon.ico"', 'href="/icon-32.png"']) {
      expect(HOME, `missing <link ${rel}>`).toContain(rel);
    }
  });

  it("preloads the display face from this origin, and the file exists", () => {
    const href = HOME.match(/<link rel="preload" href="([^"]+\.woff2)" as="font" type="font\/woff2" crossorigin>/)?.[1];
    expect(href, "no font preload in dist/index.html").toMatch(/^\/_astro\/archivo-/);
    expect(existsSync(join(DIST, href!))).toBe(true);
  });

  it("gives every page its own title and description", () => {
    const pages = ["index.html", "changelog/index.html", "privacy/index.html", "privacy/desktop/index.html", "404.html"];
    const titles = pages.map((p) => read(p).match(/<title>([^<]+)<\/title>/)?.[1]);
    const descriptions = pages.map((p) => meta(read(p), "description"));
    expect(new Set(titles).size, `duplicate <title>: ${titles.join(" | ")}`).toBe(pages.length);
    expect(new Set(descriptions).size, "duplicate meta description").toBe(pages.length);
  });

  it("keeps the 404 out of search results, and only the 404", () => {
    expect(meta(read("404.html"), "robots")).toMatch(/noindex/);
    expect(meta(HOME, "robots")).not.toMatch(/noindex/);
    expect(meta(HOME, "robots")).toMatch(/max-image-preview:large/);
  });

  it("gives the 404 no canonical or og:url, since /404/ is not a real address", () => {
    const html = read("404.html");
    expect(html).not.toMatch(/<link[^>]*rel="canonical"/);
    expect(meta(html, "og:url")).toBeUndefined();
    expect(HOME).toMatch(/<link[^>]*rel="canonical"/);
  });

  it("loads nothing from Google Fonts", () => {
    for (const page of ["index.html", "privacy/index.html"]) {
      expect(read(page), `${page} still references a Google font host`).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    }
  });
});

describe("the manifest", () => {
  const manifest = () => JSON.parse(read("site.webmanifest"));

  it("carries the fields browsers read", () => {
    const m = manifest();
    expect(m).toMatchObject({
      name: site.name,
      short_name: site.name,
      description: site.description,
      start_url: "/",
      scope: "/",
      display: "browser",
      background_color: site.themeColor,
      theme_color: site.themeColor,
    });
  });

  it("lists icons that exist at the size they claim, one of them maskable", () => {
    const icons: { src: string; sizes: string; purpose: string }[] = manifest().icons;
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const icon of icons) {
      const [w, h] = pngSize(icon.src.slice(1));
      expect(`${w}x${h}`, `${icon.src} is not ${icon.sizes}`).toBe(icon.sizes);
    }
  });

  it("matches the theme-color the page declares", () => {
    expect(meta(HOME, "theme-color")).toBe(manifest().theme_color);
  });
});

describe("icon and card files", () => {
  const SIZES: Record<string, [number, number]> = {
    "icon-32.png": [32, 32],
    "apple-touch-icon.png": [180, 180],
    "icon-192.png": [192, 192],
    "icon-512.png": [512, 512],
    "icon-maskable-512.png": [512, 512],
    "og.png": [1200, 630],
  };

  for (const [file, size] of Object.entries(SIZES)) {
    it(`${file} is ${size.join("x")}`, () => {
      expect(pngSize(file)).toEqual(size);
    });
  }

  it("favicon.ico holds 16, 32 and 48", () => {
    const bytes = readFileSync(join(DIST, "favicon.ico"));
    expect(bytes.readUInt16LE(2), "not an ICO").toBe(1);
    const count = bytes.readUInt16LE(4);
    const sides = Array.from({ length: count }, (_, i) => bytes[6 + i * 16] || 256).sort((a, b) => a - b);
    expect(sides).toEqual([16, 32, 48]);
  });

  it("keeps the share card under 300 KB", () => {
    expect(statSync(join(DIST, "og.png")).size).toBeLessThan(300 * 1024);
  });
});

describe("structured data", () => {
  const graph = () => {
    const raw = HOME.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
    expect(raw, "no JSON-LD block in dist/index.html").toBeTruthy();
    return JSON.parse(raw!)["@graph"] as Record<string, unknown>[];
  };

  it("is one graph of Organization, WebSite and SoftwareApplication", () => {
    expect(graph().map((n) => n["@type"]).sort()).toEqual(["Organization", "SoftwareApplication", "WebSite"]);
  });

  it("resolves every @id reference inside the graph", () => {
    const nodes = graph();
    const ids = new Set(nodes.map((n) => n["@id"]));
    const refs = JSON.stringify(nodes).match(/\{"@id":"[^"]+"\}/g) ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ids.has(JSON.parse(ref)["@id"]), `${ref} points at nothing`).toBe(true);
  });

  it("makes no claim the forbidden-claims list rules out", () => {
    const text = JSON.stringify(graph());
    for (const key of ["offers", "price", "downloadUrl", "aggregateRating", "review", "installUrl"]) {
      expect(text, `JSON-LD contains "${key}" — see structuredData in copy.ts`).not.toContain(`"${key}"`);
    }
    const app = graph().find((n) => n["@type"] === "SoftwareApplication")!;
    expect(app.operatingSystem).toBe("macOS, Windows");
    expect(text).not.toMatch(/linux/i);
  });
});

describe("sitemap and robots", () => {
  it("lists every indexable page with a lastmod, and not the 404", () => {
    const xml = read("sitemap.xml");
    const entries = [...xml.matchAll(/<loc>([^<]+)<\/loc><lastmod>(\d{4}-\d{2}-\d{2})<\/lastmod>/g)].map((m) => new URL(m[1]).pathname);
    expect(entries).toEqual(["/", "/changelog/", "/privacy/", "/privacy/desktop/"]);
    expect(xml).not.toMatch(/404/);
  });

  it("points robots.txt at the sitemap", () => {
    expect(read("robots.txt")).toMatch(/^Sitemap: https:\/\/.+\/sitemap\.xml$/m);
  });
});

describe("_headers", () => {
  const headers = () => read("_headers");

  it("sends HSTS for two years without the preload token", () => {
    expect(headers()).toMatch(/^  Strict-Transport-Security: max-age=63072000; includeSubDomains$/m);
    expect(headers()).not.toMatch(/preload\s*$/m);
  });

  it("caches fingerprinted assets forever, after detaching the site-wide value", () => {
    const block = headers().split(/^\/_astro\/\*$/m)[1]?.split(/^\S/m)[0] ?? "";
    expect(block).toContain("! Cache-Control");
    expect(block).toContain("Cache-Control: public, max-age=31536000, immutable");
  });

  it("serves the manifest with its registered type", () => {
    expect(headers()).toMatch(/^\/site\.webmanifest\n(?:  .*\n)*  Content-Type: application\/manifest\+json/m);
  });

  it("keeps comments at column 0, where Pages reads them as comments", () => {
    expect(headers()).not.toMatch(/^[ \t]+#/m);
  });
});

describe("the footer", () => {
  it("never renders a <placeholder> to visitors", () => {
    const foot = HOME.match(/<footer[\s\S]*?<\/footer>/)?.[0] ?? "";
    expect(foot, "no <footer> in dist/index.html").not.toBe("");
    expect(foot, "the footer shows an unfilled placeholder").not.toMatch(/&lt;[a-z][^&]*&gt;/);
  });
});

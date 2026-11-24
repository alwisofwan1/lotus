// Preview (#284): the app this chat is building, open beside it. Pure: the address the chat
// already mentions, which browsers stay loaded, and what a pick sends.

import type { Attachment } from "./thread-event";
import type { ThreadState } from "./thread-state";

const LOOPBACK = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s"'`<>()\]]*)?/g;

/**
 * The newest local address in what the agent ran or said, so Preview opens it without typing.
 * A dev server started in the background prints nothing until later, but the agent names it.
 */
export function detectedServer(state: ThreadState | null): { url: string; command: string | null } | null {
  const turns = state?.turns ?? [];
  for (let t = turns.length - 1; t >= 0; t--) {
    const items = turns[t].items;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i].item;
      const text =
        item.kind === "command" ? `${item.command}\n${item.output ?? ""}` : item.kind === "agentMessage" ? item.text : item.kind === "tool" ? item.output : null;
      const found = text?.match(LOOPBACK)?.at(-1);
      if (found) {
        return {
          url: found.replace("0.0.0.0", "localhost").replace(/[.,;:!?]+$/, ""),
          command: item.kind === "command" ? item.command : null,
        };
      }
    }
  }
  return null;
}

/** What was typed in the address bar as a URL: a local address is http, anything else https. */
export function addressOf(typed: string): string | null {
  const value = typed.trim();
  if (!value) return null;
  if (/^(https?|file):\/\//i.test(value)) return value;
  return `${/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/.*)?$/i.test(value) ? "http" : "https"}://${value}`;
}

/**
 * Where "Open in browser" sends the page: a web address as is, a `file://` page as its path, which
 * macOS opens in the default browser (the link opener takes web addresses only).
 */
export function externalTarget(url: string): { kind: "web"; url: string } | { kind: "file"; path: string } | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return { kind: "file", path: decodeURIComponent(parsed.pathname) };
    return /^https?:$/.test(parsed.protocol) ? { kind: "web", url } : null;
  } catch {
    return null;
  }
}

/** Browsers loaded at once; opening one more closes the one used longest ago. */
export const LOADED_BROWSERS = 3;

/** `id` used now: it moves to the end, and what falls past the cap is returned to close. */
export function touchBrowser(loaded: readonly string[], id: string, cap = LOADED_BROWSERS): { loaded: string[]; evicted: string[] } {
  const next = [...loaded.filter((x) => x !== id), id];
  return { loaded: next.slice(-cap), evicted: next.slice(0, Math.max(0, next.length - cap)) };
}

/** What the page's pick overlay reports for one element. */
export interface PickPayload {
  id?: string;
  url?: string;
  selector?: string;
  label?: string;
  text?: string;
  summary?: string[];
  visualAttachments?: { name: string; content?: string }[];
  boundingBox?: { x: number; y: number; width: number; height: number };
  viewport?: { width: number; height: number; scrollX: number; scrollY: number };
  computedStyles?: Record<string, string>;
  outerHTML?: string;
  reactComponent?: string;
}

/** Where the picked element sits in what the browser shows, to cut its screenshot; null if unknown. */
export function cropOf(payload: PickPayload) {
  const box = payload.boundingBox;
  const view = payload.viewport;
  if (!box || !view || box.width <= 0 || box.height <= 0 || view.width <= 0 || view.height <= 0) return null;
  // The box is in page coordinates; the screenshot is of the viewport.
  return { x: box.x - view.scrollX, y: box.y - view.scrollY, width: box.width, height: box.height, viewportWidth: view.width, viewportHeight: view.height };
}

/** An element picked on the page, waiting in the composer until it is sent. */
export interface Pick {
  id: string;
  url: string;
  selector: string;
  /** The element's tag: "img", "button". */
  tag: string;
  /** What a person reads on it, if anything. */
  text: string | null;
  /** A screenshot of the element, or the pictures inside it when one could not be taken; data URLs. */
  images: { name: string; content: string }[];
  box: { x: number; y: number; width: number; height: number } | null;
  /** Design details (Orca's Design Mode): the React component, the styles that decide how it looks
   *  ("color: …; font-size: …"), and a short piece of its HTML. Absent on an older overlay. */
  component?: string | null;
  styles?: string | null;
  html?: string | null;
  /** The images, saved for the thread so they go as pictures. */
  attachments: Attachment[];
}

/** The overlay's report as a pick; null without a page to point at. */
export function pickFrom(payload: PickPayload): Omit<Pick, "attachments"> | null {
  const url = payload.url?.trim();
  if (!url) return null;
  const tag = /^element: ([\w-]+)/.exec(payload.summary?.[0] ?? "")?.[1] ?? /^[\w-]+/.exec(payload.label?.trim() ?? "")?.[0] ?? "element";
  return {
    id: payload.id?.trim() || crypto.randomUUID(),
    url,
    selector: payload.selector?.trim() || "body",
    tag: tag.toLowerCase(),
    text: payload.text?.replace(/\s+/g, " ").trim().slice(0, 120) || null,
    images: (payload.visualAttachments ?? []).flatMap((a) => (a?.content?.startsWith("data:image/") ? [{ name: a.name, content: a.content }] : [])).slice(0, 2),
    box: payload.boundingBox ?? null,
    component: payload.reactComponent?.trim() || null,
    styles: Object.entries(payload.computedStyles ?? {}).map(([k, v]) => `${k}: ${v}`).join("; ") || null,
    html: payload.outerHTML?.trim() || null,
  };
}

/** The design details of a pick as `<pick />` attributes; Chat, Code and Canvas send the same. */
export function pickDetails(pick: Pick | Omit<Pick, "attachments">): string[] {
  const parts: string[] = [];
  if (pick.component) parts.push(`component="${attr(pick.component)}"`);
  if (pick.styles) parts.push(`styles="${attr(pick.styles)}"`);
  if (pick.html) parts.push(`html="${attr(pick.html)}"`);
  return parts;
}

/**
 * `next` added to the composer's picks. The overlay reports one pick up to four times under one id
 * (two channels, then again once its pictures load), so a repeat only fills in missing pictures; picking
 * the same element again replaces the older pick.
 */
export function addPick(picks: readonly Pick[], next: Pick): Pick[] {
  const same = picks.find((p) => p.id === next.id);
  if (same) {
    if (same.attachments.length > 0 || next.attachments.length === 0) return [...picks];
    return picks.map((p) => (p === same ? { ...p, images: next.images, attachments: next.attachments } : p));
  }
  return [...picks.filter((p) => p.url !== next.url || p.selector !== next.selector), next];
}

/** The pick's page path, for the chip: "localhost:3000/login". */
export function pickPlace(pick: { url: string }): string {
  try {
    const url = new URL(pick.url);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return pick.url;
  }
}

/** A pick as it travels in a sent message, read back to draw it as a chip. */
export interface SentPick {
  url: string;
  selector: string;
  tag: string;
  text: string | null;
}

const OPEN = "<picked-elements>";
const CLOSE = "</picked-elements>";
const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/\n/g, " ");
const unattr = (v: string) => v.replace(/&lt;/g, "<").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/**
 * The message with what was picked ahead of it: one line per element, so the agent knows which
 * element "it" is without a page of noise, and the timeline can draw each line back as a chip.
 */
export function withPicks(text: string, picks: readonly Pick[]): string {
  if (picks.length === 0) return text;
  const lines = picks.map((p) => {
    const parts = [`page="${attr(p.url)}"`, `selector="${attr(p.selector)}"`, `element="${attr(p.tag)}"`];
    if (p.text) parts.push(`text="${attr(p.text)}"`);
    parts.push(...pickDetails(p));
    if (p.box) parts.push(`box="${p.box.x},${p.box.y} ${p.box.width}x${p.box.height}"`);
    if (p.attachments.length > 0) parts.push(`pictures="${p.attachments.length} attached"`);
    return `<pick ${parts.join(" ")} />`;
  });
  return `${OPEN}\n${lines.join("\n")}\n${CLOSE}\n\n${text}`.trim();
}

/** A sent message split back into its picks and what the person wrote. */
export function splitPicks(text: string): { picks: SentPick[]; text: string } {
  if (!text.startsWith(OPEN)) return { picks: [], text };
  const end = text.indexOf(CLOSE);
  if (end < 0) return { picks: [], text };
  const picks = text
    .slice(OPEN.length, end)
    .split("\n")
    .flatMap((line) => {
      const a = Object.fromEntries(Array.from(line.matchAll(/(\w+)="([^"]*)"/g), (m) => [m[1], unattr(m[2])]));
      return a.page && a.selector ? [{ url: a.page, selector: a.selector, tag: a.element ?? "element", text: a.text ?? null }] : [];
    });
  return { picks, text: text.slice(end + CLOSE.length).trim() };
}

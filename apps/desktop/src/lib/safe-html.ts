/**
 * HTML from content (a vault note, a Notion page) made safe to hand to an editor.
 *
 * Setting `innerHTML` on an element of the LIVE document loads what it names at once: a
 * `<img src=x onerror=…>` runs its handler even while the element is detached, and app scripts
 * can reach IPC (and a PTY) — checked in the app's WKWebView. An element of an inert document
 * (`createHTMLDocument`) loads and runs nothing, so all parsing happens there, and what could be
 * active once it reaches the live page is removed before the HTML leaves.
 */

const ACTIVE_ELEMENTS = "script,iframe,frame,frameset,object,embed,style,link,meta,base,form,template,noscript,svg,math";
const URL_ATTRIBUTES = ["href", "src", "action", "formaction", "xlink:href", "srcset", "poster", "background"];
// An image may be inline; any other `data:` URL (an HTML page, an SVG with script) may not.
const SAFE_DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp|avif|bmp);/i;

function unsafeUrl(value: string): boolean {
  // Browsers ignore control characters and spaces inside the scheme ("java\tscript:").
  const compact = value.replace(/[\u0000- \u007f]+/g, "").toLowerCase();
  if (compact.startsWith("javascript:") || compact.startsWith("vbscript:")) return true;
  return compact.startsWith("data:") && !SAFE_DATA_IMAGE.test(compact);
}

/** A `<div>` of an inert document holding `html` with active content removed. */
export function inertSanitizedElement(html: string): HTMLDivElement {
  const element = document.implementation.createHTMLDocument("").createElement("div");
  element.innerHTML = html;
  for (const node of Array.from(element.querySelectorAll(ACTIVE_ELEMENTS))) node.remove();
  for (const node of Array.from(element.querySelectorAll("*"))) {
    for (const attribute of Array.from(node.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || (URL_ATTRIBUTES.includes(name) && unsafeUrl(attribute.value))) {
        node.removeAttribute(attribute.name);
      }
    }
  }
  return element;
}

export function sanitizeHtml(html: string): string {
  return inertSanitizedElement(html).innerHTML;
}

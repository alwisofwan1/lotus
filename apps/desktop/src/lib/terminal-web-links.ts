import { WebLinksAddon } from "@xterm/addon-web-links";
import type { ILinkHandler } from "@xterm/xterm";
import { openExternalLink } from "./tauri-api";

/**
 * The default xterm WebLinksAddon opens links with `window.open()`, which is a no-op in the Tauri
 * WKWebView (popups return null) — so clicking a URL in a terminal silently does nothing. These
 * helpers route a clicked link to the OS browser via the Tauri shell opener instead.
 */

// Mirror the Rust `open_external_link` allowlist so we never hand it a scheme it will reject.
const OPENABLE_SCHEME = /^(https?:\/\/|mailto:|tel:)/i;

/** Whether a terminal-detected URI is a safe external link we should open. */
export function isOpenableTerminalLink(uri: string): boolean {
  return OPENABLE_SCHEME.test(uri.trim());
}

/**
 * Open a clicked terminal link through the OS browser. Returns true when the link was openable
 * (and an open was attempted), false when it was ignored. The opener is injectable for testing.
 */
export function activateTerminalWebLink(
  uri: string,
  open: (url: string) => void | Promise<void> = openExternalLink,
): boolean {
  const trimmed = uri.trim();
  if (!isOpenableTerminalLink(trimmed)) return false;
  void open(trimmed);
  return true;
}

function linkHost(event: MouseEvent): HTMLElement | null {
  return event.target instanceof Element ? event.target.closest<HTMLElement>(".xterm") : null;
}

/**
 * xterm's `linkHandler` for OSC 8 hyperlinks (what Claude Code prints, given FORCE_HYPERLINK).
 * The URI lives in the escape, not the text, so a link Ink wrapped over two rows opens whole.
 * xterm's default asks via confirm() then window.open(): both dead in the WKWebView. Hover shows
 * the full target as a tooltip, since a link's label can differ from where it goes.
 */
export function createTerminalOscLinkHandler(
  // Lazy: the module-level handler below runs this at import, before any test mock has the export.
  open: (url: string) => void | Promise<void> = (url) => openExternalLink(url),
): ILinkHandler {
  return {
    activate: (event, uri) => {
      event.preventDefault();
      activateTerminalWebLink(uri, open);
    },
    hover: (event, uri) => {
      const host = linkHost(event);
      if (host) host.title = uri;
    },
    leave: (event) => {
      linkHost(event)?.removeAttribute("title");
    },
  };
}

export const terminalOscLinkHandler = createTerminalOscLinkHandler();

/**
 * A WebLinksAddon wired to open links via the OS browser — the drop-in replacement for the bare
 * `new WebLinksAddon()` whose default `window.open()` handler is dead in the WKWebView.
 */
export function createTerminalWebLinksAddon(): WebLinksAddon {
  return new WebLinksAddon((event, uri) => {
    event.preventDefault();
    activateTerminalWebLink(uri);
  });
}

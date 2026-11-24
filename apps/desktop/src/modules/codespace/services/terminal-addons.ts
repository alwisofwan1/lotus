import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebLinksAddon } from "@xterm/addon-web-links";
import type { WebglAddon } from "@xterm/addon-webgl";
import type { Unicode11Addon } from "@xterm/addon-unicode11";
import type { SearchAddon } from "@xterm/addon-search";
import type { ClipboardAddon } from "@xterm/addon-clipboard";
import { createTerminalClipboardProvider } from "@/modules/codespace/services/terminal-clipboard-provider";
import { openExternalLink, openPathInEditor } from "@/lib/tauri-api";
import {
  createTerminalLinkClickGuard,
  detectTerminalLinksInLine,
  normalizeTerminalLink,
  TERMINAL_LINK_REGEX,
  type TerminalDetectedLink,
} from "@/modules/codespace/services/terminal-links";
import {
  recordTerminalWebglContextLoss,
  shouldActivateTerminalWebgl,
  type TerminalWebglActivationContext,
} from "@/modules/codespace/services/terminal-webgl-policy";

export interface TerminalAddons {
  fitAddon: FitAddon;
  webLinksAddon: WebLinksAddon;
  /**
   * Always null immediately after loadTerminalAddons().
   * Set by the caller after invoking activateWebglRenderer() post-fit.
   * dispose() reads this field at call time, so late-setting is safe.
   */
  webglAddon: WebglAddon | null;
  unicode11Addon: Unicode11Addon | null;
  searchAddon: SearchAddon | null;
  clipboardAddon: ClipboardAddon | null;
  dispose(): void;
}

export interface TerminalLinkContextMenuPayload {
  clientX: number;
  clientY: number;
  link: TerminalDetectedLink;
  /** How the link was triggered: a left-click ("activate" → open directly) or a right-click
   *  ("contextmenu" → show the menu). Absent means contextmenu (back-compat). */
  trigger?: "activate" | "contextmenu";
}

export interface TerminalAddonOptions {
  cwd?: string;
  onLinkContextMenu?: (payload: TerminalLinkContextMenuPayload) => void;
}

function setTerminalLinkCursor(term: Terminal, isHovering: boolean) {
  term.element?.classList.toggle("terminal-link-hover", isHovering);
}

export async function activateDetectedLink(link: TerminalDetectedLink, cwd?: string) {
  if (link.kind === "external") {
    await openExternalLink(link.url);
    return;
  }
  if (!cwd) return;
  await openPathInEditor(link.path, cwd, link.line, link.column);
}

/**
 * Loads all terminal addons except WebGL.
 *
 * WebGL MUST be loaded after fit() so the renderer initialises at the correct
 * canvas size. Call activateWebglRenderer(term) after the first fit() and
 * assign the result to addons.webglAddon. dispose() reads webglAddon at call
 * time, so late-assignment is safe.
 *
 * Required addons (fit, web-links) throw on failure.
 * Optional addons (unicode11, search, clipboard) return null on failure.
 * Must be called AFTER term.open().
 */
export async function loadTerminalAddons(
  term: Terminal,
  isDisposed?: () => boolean,
  options: TerminalAddonOptions = {},
): Promise<TerminalAddons> {
  let hoveredLink: TerminalDetectedLink | null = null;
  const cleanup: Array<() => void> = [];
  const clickGuard = createTerminalLinkClickGuard(term.element, () => term.hasSelection());
  cleanup.push(() => clickGuard.dispose());

  const [{ FitAddon }, { WebLinksAddon }] = await Promise.all([
    import("@xterm/addon-fit"),
    import("@xterm/addon-web-links"),
  ]);

  const fitAddon = new FitAddon();
  const webLinksAddon = new WebLinksAddon(async (event, uri) => {
    if (!clickGuard.allows(event)) return;
    event.preventDefault();
    const normalized = normalizeTerminalLink(uri);
    if (!normalized) return;
    try {
      await openExternalLink(normalized);
    } catch (error) {
      console.error("[terminal] Failed to open external link:", normalized, error);
    }
  }, {
    urlRegex: TERMINAL_LINK_REGEX,
    hover: (_event, text) => {
      const normalized = normalizeTerminalLink(text);
      hoveredLink = normalized
        ? { kind: "external", text, url: normalized, start: 0, end: text.length }
        : null;
      setTerminalLinkCursor(term, true);
    },
    leave: () => {
      hoveredLink = null;
      setTerminalLinkCursor(term, false);
    },
  });
  term.loadAddon(fitAddon);
  term.loadAddon(webLinksAddon);

  const customLinkProvider = term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const lineText = term.buffer.active.getLine(bufferLineNumber - 1)?.translateToString(true) ?? "";
      const links = detectTerminalLinksInLine(lineText)
        .filter((link) => link.kind !== "external" || !/^https?:\/\//i.test(link.text))
        .map((link) => ({
          range: {
            start: { x: link.start + 1, y: bufferLineNumber },
            end: { x: link.end, y: bufferLineNumber },
          },
          text: link.text,
          decorations: { pointerCursor: true, underline: true },
          activate: async (event: MouseEvent) => {
            if (!clickGuard.allows(event)) return;
            event.preventDefault();
            try {
              await activateDetectedLink(link, options.cwd);
            } catch (error) {
              console.warn("[terminal] Failed to open terminal link:", link.text, error);
            }
          },
          hover: () => {
            hoveredLink = link;
            setTerminalLinkCursor(term, true);
          },
          leave: () => {
            hoveredLink = null;
            setTerminalLinkCursor(term, false);
          },
        }));
      callback(links.length > 0 ? links : undefined);
    },
  });
  cleanup.push(() => customLinkProvider.dispose());

  const contextMenuHandler = (event: Event) => {
    if (!hoveredLink || !options.onLinkContextMenu) return;
    const mouseEvent = event as MouseEvent;
    mouseEvent.preventDefault();
    options.onLinkContextMenu({
      clientX: mouseEvent.clientX,
      clientY: mouseEvent.clientY,
      link: hoveredLink,
    });
  };
  term.element?.addEventListener("contextmenu", contextMenuHandler);
  cleanup.push(() => term.element?.removeEventListener("contextmenu", contextMenuHandler));

  if (isDisposed?.()) {
    fitAddon.dispose();
    webLinksAddon.dispose();
    const empty: TerminalAddons = {
      fitAddon, webLinksAddon,
      webglAddon: null, unicode11Addon: null, searchAddon: null, clipboardAddon: null,
      dispose: () => { cleanup.forEach((fn) => fn()); fitAddon.dispose(); webLinksAddon.dispose(); },
    };
    return empty;
  }

  let unicode11Addon: Unicode11Addon | null = null;
  try {
    const { Unicode11Addon: Unicode11 } = await import("@xterm/addon-unicode11");
    const addon = new Unicode11();
    term.loadAddon(addon);
    term.unicode.activeVersion = "11";
    unicode11Addon = addon;
  } catch {
    console.warn("Unicode11 addon failed to load");
  }

  let searchAddon: SearchAddon | null = null;
  try {
    const { SearchAddon: Search } = await import("@xterm/addon-search");
    const addon = new Search();
    term.loadAddon(addon);
    searchAddon = addon;
  } catch {
    console.warn("Search addon failed to load");
  }

  let clipboardAddon: ClipboardAddon | null = null;
  try {
    const { ClipboardAddon: Clipboard } = await import("@xterm/addon-clipboard");
    // With no provider the addon uses the browser clipboard directly, and an OSC 52 arriving
    // from a PTY has no user gesture behind it — WKWebView throws NotAllowedError from inside
    // `terminal.write()`. See `terminal-clipboard-provider.ts`.
    const addon = new Clipboard(undefined, createTerminalClipboardProvider());
    term.loadAddon(addon);
    clipboardAddon = addon;
  } catch {
    console.warn("Clipboard addon failed to load");
  }

  // Build result as a single object so makeDispose captures the same reference
  // the caller receives. This allows late-setting addons.webglAddon after fit()
  // and having dispose() correctly clean it up.
  const result: TerminalAddons = {
    fitAddon,
    webLinksAddon,
    webglAddon: null,
    unicode11Addon,
    searchAddon,
    clipboardAddon,
    dispose: () => {
      cleanup.forEach((fn) => fn());
      result.clipboardAddon?.dispose();
      result.searchAddon?.dispose();
      result.unicode11Addon?.dispose();
      result.webglAddon?.dispose();
      result.webLinksAddon.dispose();
      result.fitAddon.dispose();
    },
  };
  return result;
}

/**
 * Loads and attaches the WebGL renderer addon.
 *
 * Must be called AFTER fit() so the GPU buffer allocates at the correct canvas
 * dimensions. Respects the webgl policy (off/force/auto) and the context-loss
 * backoff. On context loss, disposes itself and records a 24h backoff so
 * subsequent terminals fall back to the canvas renderer automatically.
 *
 * Returns the addon on success, null if skipped or on any error.
 */
export interface WebglRendererCallbacks extends TerminalWebglActivationContext {
  /**
   * Fired when the WebGL context is lost (GPU process kill, browser reclaim,
   * dimension change beyond GPU limits). The addon is disposed before this
   * callback runs; consumers must clear any stored addon reference and force
   * the fallback renderer to repaint, otherwise the viewport freezes on the
   * now-defunct GPU canvas.
   */
  onLost?: () => void;
  /**
   * Is `term` no longer the terminal worth accelerating? Re-checked AFTER the dynamic import
   * resolves, which is the only place it helps.
   *
   * This function awaits `import("@xterm/addon-webgl")`, so it hands control back and resumes a
   * task or more later. React StrictMode (Next's dev default) mounts, unmounts, then remounts
   * every terminal node, so cleanup routinely runs `term.dispose()` inside that window. Loading
   * the addon onto a disposed terminal throws from inside the addon: WebglAddon builds a
   * LinkRenderLayer out of `term._core.linkifier`, and xterm 6 hands that out through a
   * MutableDisposable whose getter returns `undefined` once disposed
   * (`get value(){ return this._isDisposed ? void 0 : this._value }`), so the addon dereferences
   * `undefined.onShowLinkUnderline`.
   *
   * A guard the CALLER checks after awaiting this function is too late — the throw already
   * happened in here. So the predicate has to come in.
   */
  isStale?: () => boolean;
}

export async function activateWebglRenderer(
  term: Terminal,
  callbacks?: WebglRendererCallbacks,
): Promise<WebglAddon | null> {
  if (!shouldActivateTerminalWebgl(callbacks)) return null;

  let Webgl: typeof WebglAddon;
  try {
    ({ WebglAddon: Webgl } = await import("@xterm/addon-webgl"));
  } catch (err) {
    console.warn("[terminal] WebGL2 addon failed to load, using canvas renderer:", err);
    return null;
  }

  // A terminal that died while the import was in flight is a lifecycle race, not a GPU problem —
  // so bail silently. Reporting it as "WebGL2 not available" is what sent readers of the dev log
  // hunting a driver bug that was never there.
  if (callbacks?.isStale?.()) return null;

  try {
    const addon = new Webgl();
    addon.onContextLoss(() => {
      recordTerminalWebglContextLoss();
      addon.dispose();
      callbacks?.onLost?.();
    });
    term.loadAddon(addon);
    return addon;
  } catch (err) {
    console.warn("[terminal] WebGL2 not available, using canvas renderer:", err);
    return null;
  }
}

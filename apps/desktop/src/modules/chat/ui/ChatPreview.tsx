"use client";

import { ArrowUpRight, ChevronLeft, ChevronRight, Lock, MousePointerClick, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import {
  browserPreviewReachable,
  browserPreviewSlotSuffix,
  captureEmbeddedBrowserPreview,
  closeEmbeddedBrowserPreview,
  goBackEmbeddedBrowserPreview,
  goForwardEmbeddedBrowserPreview,
  listenBrowserAnnotationEvents,
  listenBrowserPreviewLoad,
  openEmbeddedBrowserPreview,
  reloadEmbeddedBrowserPreview,
  setEmbeddedBrowserPreviewVisible,
  startEmbeddedBrowserAnnotationMode,
  stopEmbeddedBrowserAnnotationMode,
  syncEmbeddedBrowserPreviewBounds,
  type BrowserAnnotationPayload,
} from "@/lib/tauri/browser-preview";

import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import { useSurfaceVisible } from "@/lib/surface-visible";
import { openExternalLink, openPathReference } from "@/lib/tauri-api";
import { useAriaKeyShortcuts, useFormatShortcut } from "@/lib/hooks/useShortcutLabel";
import { addressOf, externalTarget, pickPlace, touchBrowser, type Pick, type SentPick } from "../domain/preview";

// Mockup: mockups/lotus-chat.fig, pages "05d Preview" and "05e Preview · Compare", option C (#284).
// The page is a native browser drawn over the window: it is placed, never animated, and hidden
// whenever a Lotus popup would land on it.

/** What the bar shows while not being edited: a page in the chat's folder by its path there. */
export function shownAddress(url: string, root?: string): string {
  if (!/^file:\/\//i.test(url)) return url;
  let path = url.slice(7);
  try {
    path = decodeURI(path);
  } catch {
    // shown as written
  }
  const base = root?.replace(/\/+$/, "");
  return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** A native browser call whose failure leaves nothing to undo; seen in the console, not as a crash. */
function quietly(action: Promise<unknown>): void {
  action.catch((reason: unknown) => console.warn("[Preview]", reason));
}

// Browsers stay loaded per chat across stage toggles and chat switches, the last three used,
// with the address each was opened at. A pinned slot (a Code pane's browser) is on screen beside
// others, so it is never evicted; its owner closes it.
let loaded: string[] = [];
const pinnedSlots = new Set<string>();
const openedAt = new Map<string, string>();
const isLoaded = (slot: string) => loaded.includes(slot) || pinnedSlots.has(slot);

/** How often a Preview waiting for its local server asks again; a refused loopback port answers at once. */
const WAIT_POLL_MS = 1000;

/**
 * A load WebKit never finished: its failures (refused, interrupted, cancelled) never reach wry, so
 * the only sign is a start with no finish. Past this the bar says so and Reload loads it again.
 */
export const STALL_MS = 20_000;

interface BrowserSurfaceProps {
  /** The native browser's slot: one browser per slot, kept loaded across hides. */
  slot: string;
  url: string | null;
  /** The chat's folder: a `file://` page may load from inside it. */
  root?: string;
  /** The address the chat mentioned, offered while nothing is open. */
  detected: { url: string; command: string | null } | null;
  onNavigate: (url: string) => void;
  onPick: (payload: BrowserAnnotationPayload) => void;
  /** On screen: false parks the native browser (it draws above the page, so CSS cannot hide it). */
  active?: boolean;
  /** Never evicted by the three-browser cap; for browsers shown side by side. */
  pinned?: boolean;
  /** Where the address bar draws; absent = the Workbench header's slot, or above the page. */
  barSlot?: Element | null;
  /** Drawn in the bar before Pick (a Code pane's link chip). */
  barExtra?: ReactNode;
  /** ⌘⇧C toggles picking here; false when another browser on screen owns the shortcut. */
  shortcut?: boolean;
}

/** The Chat Preview's browser, reused by Code mode's Browser pane (plans/code-browser-redesign). */
export function BrowserSurface({ slot, url, root, detected, onNavigate, onPick, active: asked = true, pinned = false, barSlot, barExtra, shortcut = true }: BrowserSurfaceProps) {
  // A hidden mode or parked shell keeps this mounted at opacity 0; the native browser must park too.
  const surfaceVisible = useSurfaceVisible();
  const active = asked && surfaceVisible;
  const keyLabel = useFormatShortcut();
  const ariaKeys = useAriaKeyShortcuts();
  const page = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState(url ?? "");
  const [seenUrl, setSeenUrl] = useState(url);
  /** Where the page really is now: links and Back move it away from `url`, the address asked for. */
  const [here, setHere] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** The address is local and nothing listens there yet: the page opens once its server starts. */
  const [waiting, setWaiting] = useState(false);
  /** The page as it last looked, drawn in its place while the browser steps aside for a popup. */
  const [frame, setFrame] = useState<string | null>(null);
  /** A page is on its way: a second Reload now would cancel it (WebKit -999), so it waits. */
  const [loading, setLoading] = useState(false);
  const [stalled, setStalled] = useState(false);
  const covered = useCovered(page);
  // Parked (another folder, focus mode): a pick mode left on would catch the next page's clicks.
  if (!active && picking) setPicking(false);
  /** The Workbench header's slot: the bar draws there, on the tabs' row. Without a Workbench it stays above the page. */
  const [drawerSlot, setDrawerSlot] = useState<Element | null>(null);
  const findSlot = useCallback((el: HTMLElement | null) => setDrawerSlot(el?.closest(".chat-changes")?.querySelector(".chat-drawer-slot") ?? null), []);
  const barTarget = barSlot !== undefined ? barSlot : drawerSlot;
  if (url !== seenUrl) {
    setSeenUrl(url);
    setTyped(url ?? "");
    setHere(null);
    setError(null);
    setFrame(null);
    setWaiting(false);
    setLoading(false);
    setStalled(false);
  }

  const bounds = useCallback(() => {
    const r = page.current!.getBoundingClientRect();
    return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.max(120, r.width), height: Math.max(120, r.height) };
  }, []);

  // Load (or navigate) this chat's browser. A new address navigates the browser in place: hiding
  // it first left the box blank between the two calls.
  useEffect(() => {
    if (!url || !active) return quietly(setEmbeddedBrowserPreviewVisible(slot, false));
    if (!page.current) return;
    let live = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const kept = isLoaded(slot) && openedAt.get(slot) === url;
    if (pinned) pinnedSlots.add(slot);
    else {
      const { loaded: next, evicted } = touchBrowser(loaded, slot);
      loaded = next;
      for (const id of evicted) {
        openedAt.delete(id);
        quietly(closeEmbeddedBrowserPreview(id));
      }
    }
    if (kept) {
      // Back to a loaded page: show it as it was, logins and form input included.
      quietly(syncEmbeddedBrowserPreviewBounds(bounds(), slot).then(() => setEmbeddedBrowserPreviewVisible(slot, true)));
    } else {
      const open = async () => {
        // Asked off the main thread; `live` is checked again after it, since leaving meanwhile
        // must not bring this browser back over another chat.
        const reach = await browserPreviewReachable(url).catch(() => "ok" as const);
        if (!live) return;
        setWaiting(reach === "refused");
        if (reach === "unknown-host") {
          // Said at once: WebKit drops this failure silently, and the last page would stay up.
          quietly(setEmbeddedBrowserPreviewVisible(slot, false));
          setError(`Can't find ${host(url)}. Check the address or your connection.`);
          return;
        }
        if (reach === "refused") {
          // Asks for as long as this chat's Preview stays on the address; leaving stops it.
          quietly(setEmbeddedBrowserPreviewVisible(slot, false));
          retry = setTimeout(open, WAIT_POLL_MS);
          return;
        }
        try {
          await openEmbeddedBrowserPreview(url, bounds(), slot, root);
          // Recorded even after leaving: the browser exists at this address now.
          openedAt.set(slot, url);
          if (live) setLoading(true);
        } catch (reason) {
          loaded = loaded.filter((id) => id !== slot);
          pinnedSlots.delete(slot);
          openedAt.delete(slot);
          if (live) setError(reason instanceof Error ? reason.message : String(reason));
        }
      };
      void open();
    }
    return () => {
      live = false;
      clearTimeout(retry);
    };
  }, [slot, url, root, bounds, attempt, active, pinned]);

  // Leaving the chat (or closing the Preview) hides its browser but keeps it loaded.
  useEffect(() => () => quietly(setEmbeddedBrowserPreviewVisible(slot, false)), [slot]);

  // The page box moves with the window and the drawer; the browser follows it.
  useEffect(() => {
    if (!url) return;
    let frame = 0;
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (page.current) quietly(syncEmbeddedBrowserPreviewBounds(bounds(), slot));
      });
    };
    const observer = new ResizeObserver(sync);
    if (page.current) observer.observe(page.current);
    window.addEventListener("resize", sync);
    // The Workbench slides in with a transform, which moves the box without resizing it.
    document.addEventListener("transitionend", sync);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", sync);
      document.removeEventListener("transitionend", sync);
    };
  }, [slot, url, bounds]);

  // What WebKit says of this chat's page: started (committed) and finished.
  useEffect(() => {
    if (!url) return;
    const suffix = browserPreviewSlotSuffix(slot);
    let unlisten: (() => void) | undefined;
    let live = true;
    void listenBrowserPreviewLoad(({ label, phase, url: at }) => {
      if (!label.endsWith(suffix)) return;
      if (at && /^(https?|file):/i.test(at)) setHere(at);
      setLoading(phase === "started");
      setStalled(false);
    }).then((un) => (live ? (unlisten = un) : safeTauriUnlisten(un)));
    return () => {
      live = false;
      safeTauriUnlisten(unlisten);
    };
  }, [slot, url]);

  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(timer);
  }, [loading]);

  // A Lotus popup over the page: hide the browser so the popup is seen and clickable, and show a
  // still of the page in its place. The still is taken first, since a hidden browser draws nothing.
  useEffect(() => {
    // Waiting or failed, the browser is parked and must stay so: the DOM says why.
    if (!url || !active || waiting || error || !isLoaded(slot)) return;
    if (!covered) return quietly(setEmbeddedBrowserPreviewVisible(slot, true));
    // A drag of the Workbench edge: step aside at once. A still would take up to the capture
    // timeout, and meanwhile the live page re-lays itself out on every frame of the drag.
    if (page.current?.closest(".chat-page[data-resizing]")) return quietly(setEmbeddedBrowserPreviewVisible(slot, false));
    let live = true;
    void captureEmbeddedBrowserPreview(slot)
      .then((still) => live && setFrame(still), () => {})
      .finally(() => {
        // Uncovered meanwhile: the browser was shown again, so leave it.
        if (live) quietly(setEmbeddedBrowserPreviewVisible(slot, false));
      });
    return () => {
      live = false;
    };
  }, [slot, url, covered, waiting, error, active]);


  const pickRef = useRef(onPick);
  useEffect(() => {
    pickRef.current = onPick;
  });
  useEffect(() => {
    if (!picking) return;
    let unlisten: (() => void) | undefined;
    let live = true;
    void listenBrowserAnnotationEvents((payload) => {
      setPicking(false);
      if (payload.action !== "cancel") pickRef.current(payload);
    }).then((un) => (live ? (unlisten = un) : safeTauriUnlisten(un)));
    quietly(startEmbeddedBrowserAnnotationMode(slot));
    return () => {
      live = false;
      safeTauriUnlisten(unlisten);
      quietly(stopEmbeddedBrowserAnnotationMode(slot));
    };
  }, [picking, slot]);

  useEffect(() => {
    if (!url || !active || !shortcut) return;
    const onKey = (event: KeyboardEvent) => {
      // A mode kept mounted at opacity 0 still listens: only the browser someone can see takes it.
      if (page.current && !seen(page.current)) return;
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        setPicking((p) => !p);
      } else if (event.key === "Escape") setPicking(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [url, active, shortcut]);

  const openOutside = () => {
    const now = here ?? url;
    const target = now ? externalTarget(now) : null;
    if (target?.kind === "web") quietly(openExternalLink(target.url));
    // The path is absolute, so the folder argument is never used to resolve it.
    else if (target?.kind === "file") quietly(openPathReference(target.path, "/"));
  };

  // A failed open is retried; a page loads again (Rust re-requests one that never arrived);
  // while waiting the poll already asks every second.
  const reload = () => {
    if (error) {
      setError(null);
      setAttempt((n) => n + 1);
    } else if (!waiting && (!loading || stalled)) {
      setLoading(true);
      setStalled(false);
      quietly(reloadEmbeddedBrowserPreview(slot));
    }
  };
  const busy = loading && !stalled;

  const go = (value: string) => {
    const next = addressOf(value);
    // The same address again is a reload: as state it changes nothing, so nothing would load.
    if (next === (here ?? url)) reload();
    // Back to the address asked for after the page moved away: load it again.
    else if (next === url) {
      openedAt.delete(slot);
      setHere(null);
      setAttempt((n) => n + 1);
    }
    else if (next) onNavigate(next);
  };

  const bar = (
      <form
        className="chat-stage-bar"
        aria-label="Preview address"
        onSubmit={(event) => {
          event.preventDefault();
          go(typed);
        }}
      >
        <button type="button" className="chat-stage-nav" aria-label="Back" disabled={!url} onClick={() => quietly(goBackEmbeddedBrowserPreview(slot))}>
          <ChevronLeft size={15} aria-hidden />
        </button>
        <button type="button" className="chat-stage-nav" aria-label="Forward" disabled={!url} onClick={() => quietly(goForwardEmbeddedBrowserPreview(slot))}>
          <ChevronRight size={15} aria-hidden />
        </button>
        {/* A field with a smooth border: the page's name, the full address on focus, Reload and progress inside it (mockups/chat-preview-address.html, C). */}
        <div className="chat-stage-addr" data-editing={editing || !url || undefined}>
          {!editing && /^https:/i.test(here ?? url ?? "") && <Lock className="chat-stage-lock" size={11} aria-hidden />}
          <input
            className="chat-stage-url"
            aria-label="Address"
            spellCheck={false}
            placeholder="localhost:3000"
            title={here ?? url ?? undefined}
            value={editing ? typed : shownAddress(here ?? typed, root)}
            onFocus={(event) => {
              if (here) setTyped(here);
              setEditing(true);
              // The full address, selected, as a browser's bar does.
              const input = event.currentTarget;
              requestAnimationFrame(() => input.select());
            }}
            onBlur={() => setEditing(false)}
            onChange={(event) => setTyped(event.target.value)}
          />
          <button
            type="button"
            className="chat-stage-nav"
            aria-label={busy ? "Loading" : "Reload"}
            title={stalled ? "The page did not finish loading. Load it again" : busy ? "Loading…" : "Reload"}
            data-busy={busy || undefined}
            disabled={!url || busy}
            onClick={reload}
          >
            <RotateCw size={13} aria-hidden />
          </button>
          {/* The full browser: for what this one cannot do, like a game's mouse lock or devtools. */}
          {url && externalTarget(url) && (
            <button type="button" className="chat-stage-nav" aria-label="Open in browser" title="Open in your default browser" onClick={openOutside}>
              <ArrowUpRight size={14} aria-hidden />
            </button>
          )}
          {(busy || stalled) && <span className="chat-stage-progress" data-stalled={stalled || undefined} aria-hidden />}
        </div>
        {stalled && (
          <span className="chat-stage-stalled" role="status">
            Not loading
          </span>
        )}
        <button
          type="button"
          className="chat-stage-nav chat-stage-pick"
          aria-label={picking ? "Stop picking" : "Pick an element"}
          aria-pressed={picking}
          aria-keyshortcuts={ariaKeys("⌘⇧C")}
          title={picking ? "Picking · Esc to stop" : `Pick an element · ${keyLabel("⌘⇧C")}`}
          data-on={picking || undefined}
          disabled={!url}
          onClick={() => setPicking(!picking)}
        >
          <MousePointerClick size={14} aria-hidden />
        </button>
        {barExtra}
      </form>
  );

  return (
    <section ref={findSlot} className="chat-stage" aria-label="Preview">
      {barTarget ? createPortal(bar, barTarget) : bar}
      <div ref={page} className="chat-stage-page" data-empty={!url || undefined}>
        {!url ? (
          <div className="chat-stage-empty">
            <p className="chat-stage-empty-title">Nothing open yet</p>
            {detected && (
              <button type="button" className="chat-stage-found" onClick={() => onNavigate(detected.url)}>
                <span className="chat-stage-found-url">{host(detected.url)}</span>
                {detected.command && <code className="chat-stage-found-cmd">{detected.command}</code>}
                <span className="chat-stage-open">Open</span>
              </button>
            )}
            <p className="chat-stage-empty-hint">{detected ? "or type an address above" : "Type an address above, like localhost:3000"}</p>
          </div>
        ) : waiting ? (
          <div className="chat-stage-empty" role="status">
            <p className="chat-stage-empty-title">Waiting for {host(url)}</p>
            <p className="chat-stage-empty-hint">Nothing answers there yet. The page opens as soon as the server starts.</p>
          </div>
        ) : error ? (
          <div className="chat-stage-empty">
            <p className="chat-stage-error">{error}</p>
            <button
              type="button"
              className="chat-stage-retry"
              onClick={reload}
            >
              Retry
            </button>
          </div>
        ) : (
          // Seen only while a popup hides the browser.
          frame ? (
            // eslint-disable-next-line @next/next/no-img-element -- a data URL, nothing for next/image to optimise
            <img className="chat-stage-frame" src={frame} alt="" />
          ) : (
            <p className="chat-stage-paused">{host(url)}</p>
          )
        )}
      </div>
    </section>
  );
}

interface ChatStageProps extends Omit<BrowserSurfaceProps, "slot" | "pinned" | "barSlot" | "barExtra" | "shortcut"> {
  threadId: string;
}

/** Chat's Preview: one browser per chat, the last three kept loaded. */
export function ChatStage({ threadId, ...rest }: ChatStageProps) {
  return <BrowserSurface slot={threadId} {...rest} />;
}

/** How often a covered Preview looks again for its popup having gone. */
const COVERED_POLL_MS = 250;

const COVERS = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],dialog[open],[data-radix-popper-content-wrapper],[data-covers-browser]';

type Checkable = Element & { checkVisibility?: (options: Record<string, boolean>) => boolean };
/** Drawn for the user: not under opacity 0, visibility hidden or a content-visibility skip. */
function seen(node: Element): boolean {
  const check = (node as Checkable).checkVisibility;
  // Older engines: assume seen, so a popup is never drawn under the browser.
  if (!check) return true;
  return check.call(node, { opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true });
}

/** Whether a Lotus popup overlaps `ref`; the native browser would draw over it. */
function useCovered(ref: RefObject<HTMLElement | null>): boolean {
  const [covered, setCovered] = useState(false);
  useEffect(() => {
    let frame = 0;
    let poll: ReturnType<typeof setInterval> | undefined;
    const check = () => {
      frame = 0;
      const el = ref.current;
      if (!el) return;
      // No popup at all is the common case (a streaming reply mutates the DOM per token): no layout read.
      const nodes = document.querySelectorAll(COVERS);
      let hit = false;
      if (nodes.length > 0) {
        const r = el.getBoundingClientRect();
        hit = Array.from(nodes).some((node) => {
          if (el.contains(node)) return false;
          // Only a popup someone can see: an inactive mode stays mounted at opacity 0 with
          // content-visibility hidden, and a menu left open there still has its box (2026-11-17,
          // a Code pane's title menu covered the Preview for good, so each address showed a
          // still of the page before it).
          if (!seen(node)) return false;
          const p = node.getBoundingClientRect();
          return p.width > 0 && p.height > 0 && p.left < r.right && p.right > r.left && p.top < r.bottom && p.bottom > r.top;
        });
      }
      setCovered(hit);
      // A popup can leave by layout alone (an exit animation, a class or style change on an
      // ancestor) with nothing observed; while covered, look again until it has gone.
      if (hit && !poll) poll = setInterval(schedule, COVERED_POLL_MS);
      else if (!hit && poll) {
        clearInterval(poll);
        poll = undefined;
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(check);
    };
    // Popups mount and unmount, or open and close in place.
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["open", "hidden", "class", "style", "data-state", "aria-hidden"] });
    check();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      clearInterval(poll);
    };
  }, [ref]);
  return covered;
}

/** A picked element, as a chip: in the composer with ×, and in a sent message without. */
export function PickChip({ pick, onRemove }: { pick: SentPick & { images?: Pick["images"] }; onRemove?: () => void }) {
  const image = pick.images?.[0]?.content;
  const Tag = onRemove ? "li" : "span";
  return (
    <Tag className="chat-pick" title={`${pick.url}\n${pick.selector}`}>
      <span className="chat-pick-thumb" aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element -- a data URL, nothing for next/image to optimise */}
        {image ? <img src={image} alt="" /> : <MousePointerClick size={13} />}
      </span>
      <span className="chat-pick-text">
        <span className="chat-pick-label">
          <code>{pick.tag}</code>
          {pick.text && <span>{pick.text}</span>}
        </span>
        <span className="chat-pick-where">
          {pickPlace(pick)} · {pick.selector}
        </span>
      </span>
      {onRemove && (
        <button type="button" className="chat-pick-x" aria-label={`Remove ${pick.tag}${pick.text ? ` ${pick.text}` : ""}`} onClick={onRemove}>
          <X size={12} aria-hidden />
        </button>
      )}
    </Tag>
  );
}

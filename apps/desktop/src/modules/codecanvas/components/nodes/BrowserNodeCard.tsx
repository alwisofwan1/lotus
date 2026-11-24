"use client";
import { memo, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Globe, Maximize2, Monitor, MousePointerClick, RotateCw, Smartphone, Tablet, WifiOff, X, ZoomIn, ZoomOut, type LucideIcon } from "lucide-react";
import { CanvasNodeFocusAction } from "./CanvasNodeFocusAction";
import type { BrowserNodePatch, CanvasBrowserState, CanvasBrowserViewportMode } from "../../types/canvas";
import type { CanvasBrowserAnnotationDeliveryState } from "../../services/canvas-browser-annotation-routing";
import { rotateBrowserViewportProfile, stepBrowserViewportZoom, type BrowserViewportProfile } from "../../services/browser-node-responsive";
import { browserDisplayName, normalizeBrowserLabel } from "../../services/browser-node-identity";

export interface BrowserNodeCardProps {
  browserNumber: number;
  label?: string;
  pageTitle?: string;
  url: string;
  browserState: CanvasBrowserState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  onOpen: () => void;
  onClose: () => void;
  onFocus?: () => void;
  onReload: () => void;
  onBack?: () => void;
  onForward?: () => void;
  onNavigate: (url: string) => void;
  onRename?: (label: string) => void;
  onAnnotate?: () => void;
  annotationActive?: boolean;
  annotationDeliveryState?: CanvasBrowserAnnotationDeliveryState | null;
  annotationDeliveryReason?: string | null;
  /** URL the node's origin policy just rejected — shown as a transient chip. */
  blockedNavigationUrl?: string | null;
  nativeViewSuspended?: boolean;
  /** Why the native view is parked: a transient gesture, or a blocking overlay sitting above it. */
  suspendReason?: "gesture" | "overlay";
  nativeErrorReason?: string | null;
  viewportProfile?: BrowserViewportProfile;
  onViewportChange?: (patch: BrowserNodePatch) => void;
  /** An agent is currently driving this browser (snapshot/click/type in-flight) — shows a badge. */
  agentDriving?: boolean;
}

const STATE_DOT_CLASS: Record<CanvasBrowserState, string> = {
  active: "cbh-dot--active",
  loading: "cbh-dot--loading",
  disconnected: "cbh-dot--disconnected",
};

function hostFromUrl(url: string): string {
  try { return new URL(url).host || url; }
  catch { return url; }
}

function displayUrl(url: string): string {
  if (!url || url === "about:blank") return "";
  return url.replace(/^https?:\/\//, "");
}

const STATE_LABEL: Record<CanvasBrowserState, string> = {
  active: "Live",
  loading: "Connecting",
  disconnected: "Not connected",
};

const NOT_SENT: Record<string, string> = {
  "terminal-exited": "the terminal is closed",
  "delivery-timeout": "the terminal did not take it in time",
  "missing-terminal": "this browser has no terminal",
};

/** One line under the toolbar: what happened to the last pick, or a blocked navigation. */
function noticeOf(
  state: CanvasBrowserAnnotationDeliveryState | null,
  reason: string | null,
  blockedUrl: string | null,
): { tone: "ok" | "wait" | "bad"; text: string } | null {
  if (blockedUrl) return { tone: "bad", text: `Blocked ${hostFromUrl(blockedUrl)}: outside the sites this browser may open` };
  if (state === "sent") return { tone: "ok", text: "Sent to the terminal" };
  if (state === "queued") return { tone: "wait", text: "Waiting for the terminal…" };
  if (state === "failed") return { tone: "bad", text: `Not sent: ${(reason && NOT_SENT[reason]) ?? reason ?? "the terminal did not take it"}` };
  return null;
}

const VIEWPORT_MODE_OPTIONS: Array<{
  mode: CanvasBrowserViewportMode;
  label: string;
  icon: LucideIcon;
}> = [
  { mode: "auto", label: "Auto", icon: Maximize2 },
  { mode: "desktop", label: "Desktop", icon: Monitor },
  { mode: "tablet", label: "Tablet", icon: Tablet },
  { mode: "mobile", label: "Mobile", icon: Smartphone },
];

export const BrowserNodeCard = memo(function BrowserNodeCard({
  browserNumber,
  label,
  pageTitle,
  url,
  browserState,
  containerRef,
  onOpen,
  onClose,
  onFocus,
  onReload,
  onBack,
  onForward,
  onNavigate,
  onRename,
  onAnnotate,
  annotationActive = false,
  annotationDeliveryState = null,
  annotationDeliveryReason = null,
  blockedNavigationUrl = null,
  nativeViewSuspended = false,
  suspendReason = "gesture",
  nativeErrorReason = null,
  viewportProfile,
  onViewportChange,
  agentDriving = false,
}: BrowserNodeCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const cancelRenameRef = useRef(false);
  const [viewportOpen, setViewportOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const displayName = browserDisplayName({ browserNumber, label, pageTitle, url });

  const isBlank = !url || url === "about:blank";
  const host = isBlank ? "" : hostFromUrl(url);
  const urlDisplay = displayUrl(url);
  const hasNativeError = Boolean(nativeErrorReason);
  const live = browserState === "active";
  const notice = noticeOf(annotationDeliveryState, annotationDeliveryReason, blockedNavigationUrl);
  const zoomReadout = viewportProfile ? `${Math.round(viewportProfile.zoomFactor * 100)}%` : null;
  const viewportTargetStyle = viewportProfile
    ? {
      "--cbk-target-width": `${viewportProfile.width}px`,
      "--cbk-target-height": `${viewportProfile.height}px`,
    } as CSSProperties
    : undefined;

  function handleUrlKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      const next = e.currentTarget.value.trim();
      if (next) { onNavigate(next); e.currentTarget.blur(); }
    }
    if (e.key === "Escape") {
      e.currentTarget.value = urlDisplay;
      e.currentTarget.blur();
    }
  }

  function commitRename(value: string) {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false;
      setRenaming(false);
      return;
    }
    const next = normalizeBrowserLabel(value, displayName);
    setRenaming(false);
    if (next !== displayName) onRename?.(next);
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") e.currentTarget.blur();
    if (e.key === "Escape") {
      cancelRenameRef.current = true;
      setRenaming(false);
    }
  }

  function handleRotateViewport() {
    if (!viewportProfile || !onViewportChange) return;
    const rotated = rotateBrowserViewportProfile(viewportProfile);
    onViewportChange({
      viewportOrientation: rotated.orientation,
      viewportWidth: rotated.width,
      viewportHeight: rotated.height,
    });
  }

  function handleZoom(direction: "in" | "out") {
    if (!viewportProfile || !onViewportChange) return;
    onViewportChange({
      viewportZoom: stepBrowserViewportZoom(viewportProfile, direction),
      viewportScaleMode: "actual",
    });
  }

  function handleFitViewport() {
    onViewportChange?.({ viewportScaleMode: "fit", viewportZoom: null });
  }

  return (
    <div className="cbk-root">
      {/* ── Header: name, host, live dot; actions live in the toolbar ── */}
      <div className="cbk-header">
        <span className="canvas-node-chip" aria-hidden><Globe size={12} /></span>
        {renaming ? (
          <input
            ref={titleInputRef}
            className="cbk-title-input nodrag"
            aria-label="Browser name"
            defaultValue={displayName}
            autoFocus
            onBlur={(event) => commitRename(event.currentTarget.value)}
            onKeyDown={handleTitleKeyDown}
            spellCheck={false}
          />
        ) : (
          <button
            type="button"
            className="cbk-title cbk-title-button nodrag"
            title="Rename browser"
            aria-label={`Rename ${displayName}`}
            onDoubleClick={() => setRenaming(true)}
          >
            {displayName}
          </button>
        )}
        {host && <span className="cbk-host" title={url}>· {host}</span>}
        <span className={`cbh-dot ${STATE_DOT_CLASS[browserState]}`} role="img" aria-label={STATE_LABEL[browserState]} title={STATE_LABEL[browserState]} />
        {agentDriving && (
          <span className="cbk-agent-driving" role="status" title="An agent is controlling this browser">
            <span className="cbk-agent-driving-dot" aria-hidden />
            Agent
          </span>
        )}
        <div className="cbk-header-gap" />
        <div className="cbk-actions nodrag">
          {onFocus && <CanvasNodeFocusAction onFocus={onFocus} className="cbk-btn cbk-btn--focus" />}
          <button className="cbk-btn cbk-btn--close" title="Close browser" aria-label="Close browser node" onClick={onClose}>
            <X size={13} />
          </button>
        </div>
      </div>

      {/* ── Toolbar: the chat Preview's one row ── */}
      <form
        className="cbk-bar nodrag nowheel"
        onSubmit={(e) => {
          e.preventDefault();
          const next = inputRef.current?.value.trim();
          if (next) { onNavigate(next); inputRef.current?.blur(); }
        }}
      >
        <button type="button" className="cbk-nav" aria-label="Back" title="Back" onClick={onBack} disabled={!onBack || !live}>
          <ChevronLeft size={15} />
        </button>
        <button type="button" className="cbk-nav" aria-label="Forward" title="Forward" onClick={onForward} disabled={!onForward || !live}>
          <ChevronRight size={15} />
        </button>
        <button type="button" className="cbk-nav" aria-label="Reload browser" title="Reload" onClick={onReload} disabled={browserState === "disconnected"}>
          <RotateCw size={13} />
        </button>
        <input
          ref={inputRef}
          className="cbk-urlinput"
          defaultValue={urlDisplay}
          key={url}
          placeholder="localhost:3000"
          onKeyDown={handleUrlKeyDown}
          aria-label="Browser URL"
          spellCheck={false}
          autoComplete="off"
        />
        {viewportProfile && onViewportChange && (
          <button
            type="button"
            className="cbk-vp"
            aria-label="Viewport and zoom"
            aria-expanded={viewportOpen}
            title="Viewport and zoom"
            data-on={viewportOpen || undefined}
            onClick={() => setViewportOpen((open) => !open)}
          >
            {viewportProfile.scaleMode === "fit" ? "Fit · " : ""}{zoomReadout}
            <ChevronDown size={12} />
          </button>
        )}
        {onAnnotate && (
          <button
            type="button"
            className="cbk-pick"
            data-on={annotationActive || undefined}
            aria-label={annotationActive ? "Stop picking" : "Pick an element"}
            title={annotationActive ? "Stop picking" : "Pick an element to ask the terminal about"}
            onClick={onAnnotate}
            disabled={!live}
          >
            <MousePointerClick size={13} />
            {annotationActive ? "Picking" : "Pick"}
            {annotationActive && <kbd>Esc</kbd>}
          </button>
        )}
      </form>

      {/* ── Viewport row: opened from the toolbar, never over the page (the native view would hide it) ── */}
      {viewportOpen && viewportProfile && onViewportChange && (
        <div className="cbk-devicebar nodrag" aria-label="Browser viewport controls">
          <div className="cbk-devicebar-modes" role="group" aria-label="Browser viewport mode">
            {VIEWPORT_MODE_OPTIONS.map(({ mode, label, icon: Icon }) => (
              <button
                key={mode}
                type="button"
                className={`cbk-device-btn${viewportProfile.mode === mode ? " cbk-device-btn--active" : ""}`}
                aria-label={`Use ${label.toLowerCase()} viewport`}
                aria-pressed={viewportProfile.mode === mode}
                title={label}
                onClick={() => onViewportChange({ viewportMode: mode, viewportScaleMode: "fit", viewportZoom: null })}
              >
                <Icon size={12} />
                <span className="cbk-device-label">{label}</span>
              </button>
            ))}
          </div>
          <button type="button" className="cbk-device-icon-btn" aria-label="Rotate viewport" title="Rotate viewport" onClick={handleRotateViewport}>
            <RotateCw size={12} />
          </button>
          <div className="cbk-devicebar-gap" />
          <button type="button" className="cbk-device-icon-btn" aria-label="Zoom out" title="Zoom out" onClick={() => handleZoom("out")}>
            <ZoomOut size={12} />
          </button>
          <button type="button" className="cbk-device-icon-btn" aria-label="Zoom in" title="Zoom in" onClick={() => handleZoom("in")}>
            <ZoomIn size={12} />
          </button>
          <button type="button" className="cbk-device-btn" aria-label="Fit viewport" title="Fit to the node" onClick={handleFitViewport}>
            Fit
          </button>
        </div>
      )}

      {notice && (
        <div className="cbk-notice" data-tone={notice.tone} role="status">
          <span className="cbk-notice-dot" aria-hidden />
          {notice.text}
        </div>
      )}

      {/* ── Viewport ── */}
      <div
        className="cbk-viewport"
        data-browser-state={browserState}
        data-native-suspended={nativeViewSuspended || undefined}
        data-viewport-preset={viewportProfile?.preset}
        data-viewport-orientation={viewportProfile?.orientation}
      >
        <div
          ref={containerRef}
          className="cbk-webview-target"
          style={viewportTargetStyle}
          aria-hidden="true"
        />

        {browserState === "active" && nativeViewSuspended && (
          <div className="cbk-overlay cbk-overlay--motion" aria-hidden>
            <div className="cbk-motion-bars" aria-hidden><span /><span /><span /></div>
            <p className="cbk-overlay-title">{suspendReason === "overlay" ? "Paused" : "Moving browser"}</p>
            <p className="cbk-overlay-sub">
              {suspendReason === "overlay" ? "Live view resumes when the panel closes" : "Live view resumes on release"}
            </p>
          </div>
        )}

        {browserState === "loading" && (
          <div className="cbk-overlay cbk-overlay--loading">
            <div className="cbk-spinner" role="status" aria-label="Connecting" />
            <p className="cbk-overlay-title">Connecting</p>
            {host && <p className="cbk-overlay-sub">{host}</p>}
          </div>
        )}

        {browserState === "disconnected" && (
          <div className={`cbk-overlay cbk-overlay--disconnected${hasNativeError ? " cbk-overlay--recovery" : ""}`}>
            <div className="cbk-disc-icon" aria-hidden><WifiOff size={26} /></div>
            <p className="cbk-overlay-title">{hasNativeError ? "Browser needs recovery" : "Browser closed"}</p>
            <p className="cbk-overlay-sub">{nativeErrorReason ?? (isBlank ? "No page loaded" : `Last: ${host}`)}</p>
            <button className="cbk-connect-btn" onClick={onOpen}>
              <Globe size={12} />
              <span>{hasNativeError ? "Retry browser" : isBlank ? "Open browser" : `Reconnect to ${host}`}</span>
            </button>
          </div>
        )}

      </div>
    </div>
  );
});

"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AlertTriangle, Grid2x2, Loader2, Maximize, Minus, Plus, Scan } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  clampZoom,
  fitZoom,
  formatByteSize,
  readFontNames,
  stepZoom,
  type EditorMediaType,
} from "@/modules/codespace/services/editor-media";
import { EditorState } from "./WorkbenchEditor";
import { WorkbenchPdfViewer } from "./WorkbenchPdfViewer";

type MediaSource =
  /** Bytes read from disk; a new `version` reads them again (the file changed on disk). */
  | { kind: "bytes"; load: () => Promise<ArrayBuffer>; version: number }
  /** Text in the editor buffer (SVG): the preview follows unsaved edits. */
  | { kind: "text"; text: string };

interface WorkbenchMediaPreviewProps {
  fileName: string;
  media: EditorMediaType;
  source: MediaSource;
  /** PDF only: the page to show, and the page being read. */
  page?: number | null;
  onPage?: (page: number) => void;
}

/** `bytes` is kept for viewers that read the file itself (a font's names). */
type Loaded = { url: string; sizeBytes: number; bytes: ArrayBuffer | null };

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return "The file could not be read.";
}

/** An object URL for the source, revoked when it is replaced or the viewer closes. */
function useMediaUrl(source: MediaSource, mime: string): { loaded: Loaded | null; error: string | null } {
  const [state, setState] = useState<{ loaded: Loaded | null; error: string | null }>({ loaded: null, error: null });
  const load = source.kind === "bytes" ? source.load : null;
  const version = source.kind === "bytes" ? source.version : null;
  const text = source.kind === "text" ? source.text : null;
  // `load` is a new closure on every render; `version` names the bytes it reads.
  const loadRef = useRef(load);
  useLayoutEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    const publish = (blob: Blob, bytes: ArrayBuffer | null) => {
      if (cancelled) return;
      url = URL.createObjectURL(blob);
      setState({ loaded: { url, sizeBytes: blob.size, bytes }, error: null });
    };
    if (text !== null) {
      publish(new Blob([text], { type: mime }), null);
    } else if (loadRef.current) {
      loadRef.current().then(
        (bytes) => publish(new Blob([bytes], { type: mime }), bytes),
        (error: unknown) => {
          if (!cancelled) setState({ loaded: null, error: describeError(error) });
        },
      );
    }
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [mime, text, version]);

  return state;
}

export function WorkbenchMediaPreview({ fileName, media, source, page, onPage }: WorkbenchMediaPreviewProps) {
  const { loaded, error } = useMediaUrl(source, media.mime);

  if (error) {
    return (
      <EditorState
        icon={<AlertTriangle className="h-4 w-4" />}
        title={`Cannot preview ${fileName}`}
        description={error}
        tone="danger"
      />
    );
  }
  if (!loaded) {
    return (
      <EditorState
        icon={<Loader2 className="h-4 w-4 animate-spin" />}
        title="Reading file"
        description={`Loading ${media.label.toLowerCase()}.`}
      />
    );
  }
  if (media.kind === "image") {
    return <ImageViewer url={loaded.url} sizeBytes={loaded.sizeBytes} fileName={fileName} media={media} />;
  }
  if (media.kind === "pdf" && loaded.bytes) return <WorkbenchPdfViewer bytes={loaded.bytes} fileName={fileName} page={page} onPage={onPage} />;
  if (media.kind === "font") {
    return <FontViewer url={loaded.url} bytes={loaded.bytes} sizeBytes={loaded.sizeBytes} fileName={fileName} media={media} />;
  }
  return <PlayerViewer url={loaded.url} sizeBytes={loaded.sizeBytes} fileName={fileName} media={media} />;
}

type Size = { width: number; height: number };
/** A point in the viewport, and the image pixel under it, to hold still across a zoom. */
type ZoomAnchor = { viewportX: number; viewportY: number; imageX: number; imageY: number };

const CHECKER_STORAGE_KEY = "lotus.workbench.mediaChecker";
/** An SVG with no width/height has no natural size in WebKit; it is drawn at this size. */
const FALLBACK_SIZE: Size = { width: 512, height: 512 };
/** Above this zoom pixels are drawn as squares, so an icon is inspectable instead of smeared. */
const PIXELATED_FROM = 3;

function readChecker(): boolean {
  try {
    return window.localStorage.getItem(CHECKER_STORAGE_KEY) !== "0";
  } catch {
    return true;
  }
}

function ImageViewer({ url, sizeBytes, fileName, media }: { url: string; sizeBytes: number; fileName: string; media: EditorMediaType }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const [natural, setNatural] = useState<Size | null>(null);
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  // Keyed by URL: a new file on disk gets its own chance to decode.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const failed = failedUrl === url;
  const [checker, setChecker] = useState(readChecker);
  const anchorRef = useRef<ZoomAnchor | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const size = natural ?? FALLBACK_SIZE;
  const scale = zoom === "fit" ? fitZoom(size, viewport) : zoom;
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  const overflows = width > viewport.width || height > viewport.height;

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () => setViewport({ width: scroller.clientWidth, height: scroller.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  // After a zoom, scroll so the anchored image pixel is back under the same viewport point.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const scroller = scrollerRef.current;
    const image = imageRef.current;
    anchorRef.current = null;
    if (!anchor || !scroller || !image) return;
    scroller.scrollLeft = anchor.imageX * scale + image.offsetLeft - anchor.viewportX;
    scroller.scrollTop = anchor.imageY * scale + image.offsetTop - anchor.viewportY;
  }, [scale]);

  const zoomTo = useCallback((next: "fit" | number, point?: { clientX: number; clientY: number }) => {
    const scroller = scrollerRef.current;
    const image = imageRef.current;
    if (scroller && image && next !== "fit") {
      const rect = scroller.getBoundingClientRect();
      const viewportX = point ? point.clientX - rect.left : scroller.clientWidth / 2;
      const viewportY = point ? point.clientY - rect.top : scroller.clientHeight / 2;
      anchorRef.current = {
        viewportX,
        viewportY,
        imageX: (scroller.scrollLeft + viewportX - image.offsetLeft) / scale,
        imageY: (scroller.scrollTop + viewportY - image.offsetTop) / scale,
      };
    }
    setZoom(next === "fit" ? "fit" : clampZoom(next));
  }, [scale]);

  // ⌘/Ctrl + wheel, and the trackpad pinch (WebKit sends it as a ctrl + wheel), zoom at the
  // pointer. A native listener: React's wheel handler is passive and cannot stop the page zoom.
  const scaleRef = useRef(scale);
  const zoomToRef = useRef(zoomTo);
  useLayoutEffect(() => {
    scaleRef.current = scale;
    zoomToRef.current = zoomTo;
  }, [scale, zoomTo]);
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      zoomToRef.current(scaleRef.current * Math.exp(-delta * 0.01), event);
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, []);

  const toggleChecker = () => {
    setChecker((current) => {
      try {
        window.localStorage.setItem(CHECKER_STORAGE_KEY, current ? "0" : "1");
      } catch {
        // Storage off: the choice lasts until the viewer closes.
      }
      return !current;
    });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.altKey || event.ctrlKey) return;
    const key = event.key;
    if (key === "+" || key === "=") zoomTo(stepZoom(scale, 1));
    else if (key === "-" || key === "_") zoomTo(stepZoom(scale, -1));
    else if (key === "0" && !event.metaKey) zoomTo("fit");
    else if (key === "1" && !event.metaKey) zoomTo(1);
    else return;
    event.preventDefault();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const scroller = scrollerRef.current;
    if (!scroller || event.button !== 0 || !overflows) return;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
    scroller.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const scroller = scrollerRef.current;
    if (!drag || !scroller || drag.pointerId !== event.pointerId) return;
    scroller.scrollLeft = drag.left - (event.clientX - drag.x);
    scroller.scrollTop = drag.top - (event.clientY - drag.y);
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    scrollerRef.current?.releasePointerCapture?.(event.pointerId);
    setDragging(false);
  };

  if (failed) {
    return (
      <EditorState
        icon={<AlertTriangle className="h-4 w-4" />}
        title={`Cannot display ${fileName}`}
        description={`The image could not be decoded. It may be damaged, or ${media.label} is not supported by this system.`}
        tone="danger"
      />
    );
  }

  const zoomLabel = `${Math.round(scale * 100)}%`;
  return (
    <div className="codespace-media-viewer" data-testid="workbench-media-preview">
      <div
        ref={scrollerRef}
        className={cn(
          "codespace-media-stage",
          overflows && "codespace-media-stage--pannable",
          dragging && "codespace-media-stage--dragging",
        )}
        tabIndex={0}
        role="region"
        aria-label={`${fileName} preview. Plus and minus zoom, 0 fits, 1 shows actual size.`}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(event) => zoomTo(zoom === "fit" ? Math.max(1, scale * 2) : "fit", event)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a local Blob, not an optimizable asset */}
        <img
          ref={imageRef}
          src={url}
          alt={fileName}
          draggable={false}
          className={cn("codespace-media-image", checker && "codespace-media-image--checker")}
          style={{
            width,
            height,
            imageRendering: scale >= PIXELATED_FROM ? "pixelated" : "auto",
          }}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            setNatural(naturalWidth > 0 && naturalHeight > 0 ? { width: naturalWidth, height: naturalHeight } : null);
          }}
          onError={() => setFailedUrl(url)}
        />
      </div>
      <div className="codespace-media-toolbar" role="toolbar" aria-label="Image zoom">
        <button type="button" className="codespace-workbench-toolbar-button" onClick={() => zoomTo(stepZoom(scale, -1))} aria-label="Zoom out" title="Zoom out (−)">
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="codespace-media-zoom-label"
          onClick={() => zoomTo(zoom === "fit" ? 1 : "fit")}
          title={zoom === "fit" ? "Show actual size (1)" : "Fit to window (0)"}
          aria-label={`Zoom ${zoomLabel}. ${zoom === "fit" ? "Show actual size" : "Fit to window"}`}
        >
          {zoomLabel}
        </button>
        <button type="button" className="codespace-workbench-toolbar-button" onClick={() => zoomTo(stepZoom(scale, 1))} aria-label="Zoom in" title="Zoom in (+)">
          <Plus className="h-3.5 w-3.5" />
        </button>
        <span className="codespace-media-toolbar-divider" aria-hidden="true" />
        <button
          type="button"
          className={cn("codespace-workbench-toolbar-button", zoom === "fit" && "codespace-workbench-toolbar-button--preview-on")}
          onClick={() => zoomTo("fit")}
          aria-label="Fit to window"
          aria-pressed={zoom === "fit"}
          title="Fit to window (0)"
        >
          <Maximize className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={cn("codespace-workbench-toolbar-button", zoom === 1 && "codespace-workbench-toolbar-button--preview-on")}
          onClick={() => zoomTo(1)}
          aria-label="Actual size"
          aria-pressed={zoom === 1}
          title="Actual size (1)"
        >
          <Scan className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className={cn("codespace-workbench-toolbar-button", checker && "codespace-workbench-toolbar-button--preview-on")}
          onClick={toggleChecker}
          aria-label="Transparency grid"
          aria-pressed={checker}
          title="Show transparency as a checkerboard"
        >
          <Grid2x2 className="h-3.5 w-3.5" />
        </button>
        <span className="codespace-media-toolbar-divider" aria-hidden="true" />
        <span className="codespace-media-meta">
          {natural ? `${natural.width} × ${natural.height}` : null}
          {natural ? <span aria-hidden="true"> · </span> : null}
          {formatByteSize(sizeBytes)}
        </span>
      </div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function PlayerViewer({ url, sizeBytes, fileName, media }: { url: string; sizeBytes: number; fileName: string; media: EditorMediaType }) {
  const [meta, setMeta] = useState<{ duration: number; width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <EditorState
        icon={<AlertTriangle className="h-4 w-4" />}
        title={`Cannot play ${fileName}`}
        description={`${media.label} with this encoding is not supported by this system.`}
        tone="danger"
      />
    );
  }

  const onMeta = (element: HTMLMediaElement) => {
    const video = element as HTMLVideoElement;
    setMeta({ duration: element.duration, width: video.videoWidth ?? 0, height: video.videoHeight ?? 0 });
  };

  return (
    <div className="codespace-media-viewer" data-testid="workbench-media-preview">
      <div className={cn("codespace-media-stage", media.kind === "audio" && "codespace-media-stage--audio")}>
        {media.kind === "video" ? (
          <video
            src={url}
            controls
            playsInline
            preload="metadata"
            className="codespace-media-video"
            aria-label={fileName}
            onLoadedMetadata={(event) => onMeta(event.currentTarget)}
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="codespace-media-audio-card">
            <p className="codespace-media-audio-name">{fileName}</p>
            <audio
              src={url}
              controls
              preload="metadata"
              aria-label={fileName}
              onLoadedMetadata={(event) => onMeta(event.currentTarget)}
              onError={() => setFailed(true)}
            />
          </div>
        )}
      </div>
      <div className="codespace-media-toolbar codespace-media-toolbar--info">
        <span className="codespace-media-meta">
          {[
            media.label,
            meta && meta.width > 0 ? `${meta.width} × ${meta.height}` : null,
            meta ? formatDuration(meta.duration) : null,
            formatByteSize(sizeBytes),
          ].filter(Boolean).join(" · ")}
        </span>
      </div>
    </div>
  );
}

/**
 * WebKit's own PDF viewer in a frame: pages, text selection, find and pinch zoom come with it.
 * No toolbar of ours: WebKit shows its own at the bottom on hover, where ours would cover it.
 */
const FONT_SAMPLE_SIZES = [12, 16, 24, 36, 48, 72];
const FONT_DEFAULT_SAMPLE = "The quick brown fox jumps over the lazy dog";
const FONT_GLYPHS = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789",
  "!?@#$%&*()[]{}<>/\\|+-=_~^.,:;'\"`",
];

function FontViewer({
  url,
  bytes,
  sizeBytes,
  fileName,
  media,
}: { url: string; bytes: ArrayBuffer | null; sizeBytes: number; fileName: string; media: EditorMediaType }) {
  // A family name of our own: two fonts called "Inter" in two panes must not replace each other.
  const family = `lotus-font-preview-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  // Keyed by URL: a new file on disk starts loading again.
  const [result, setResult] = useState<{ url: string; ok: boolean } | null>(null);
  const supported = typeof FontFace !== "undefined" && typeof document !== "undefined" && Boolean(document.fonts);
  const status = !supported ? "failed" : result?.url !== url ? "loading" : result.ok ? "ready" : "failed";
  const [sample, setSample] = useState("");
  const names = bytes ? readFontNames(bytes) : null;

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    const face = new FontFace(family, `url(${url})`);
    face.load().then(
      (loaded) => {
        if (cancelled) return;
        document.fonts.add(loaded);
        setResult({ url, ok: true });
      },
      () => {
        if (!cancelled) setResult({ url, ok: false });
      },
    );
    return () => {
      cancelled = true;
      document.fonts.delete(face);
    };
  }, [family, supported, url]);

  if (status === "failed") {
    return (
      <EditorState
        icon={<AlertTriangle className="h-4 w-4" />}
        title={`Cannot display ${fileName}`}
        description={`The font could not be loaded. It may be damaged, or ${media.label} is not supported by this system.`}
        tone="danger"
      />
    );
  }

  const text = sample || FONT_DEFAULT_SAMPLE;
  const fontStyle = { fontFamily: `"${family}", var(--font-sans, system-ui)` };
  return (
    <div className="codespace-media-viewer" data-testid="workbench-media-preview">
      <div className="codespace-media-stage codespace-font-stage" aria-busy={status === "loading"}>
        <div className="codespace-font-sheet" style={{ visibility: status === "ready" ? "visible" : "hidden" }}>
          <header className="codespace-font-header">
            <h2 className="codespace-font-family" style={fontStyle}>{names?.family ?? fileName}</h2>
            <p className="codespace-media-meta">
              {[names?.fullName && names.fullName !== names.family ? names.fullName : null, media.label, formatByteSize(sizeBytes)]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </header>
          <input
            type="text"
            className="codespace-font-input"
            value={sample}
            placeholder="Type to try the font"
            aria-label="Sample text"
            spellCheck={false}
            onChange={(event) => setSample(event.target.value)}
          />
          <ul className="codespace-font-samples" aria-label="Sizes">
            {FONT_SAMPLE_SIZES.map((size) => (
              <li key={size} className="codespace-font-sample">
                <span className="codespace-font-size-label">{size}</span>
                <span className="codespace-font-sample-text" style={{ ...fontStyle, fontSize: size }}>{text}</span>
              </li>
            ))}
          </ul>
          <div className="codespace-font-glyphs" style={fontStyle} aria-label="Characters">
            {FONT_GLYPHS.map((line) => <p key={line}>{line}</p>)}
          </div>
        </div>
      </div>
    </div>
  );
}

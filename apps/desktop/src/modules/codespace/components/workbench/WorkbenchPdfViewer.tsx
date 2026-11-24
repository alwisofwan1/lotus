"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Maximize, Minus, Plus } from "lucide-react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { cn } from "@/lib/utils";
import { clampZoom, stepZoom } from "@/modules/codespace/services/editor-media";

/*
 * PDFs drawn by pdf.js instead of WebKit's own viewer: that one paints a white well around the
 * pages whatever the page's color-scheme or the window's appearance (all four combinations
 * measured in a WKWebView, 2026-10-31), so a dark workbench showed a white slab.
 */

type Pdfjs = typeof import("pdfjs-dist");
let pdfjs: Promise<Pdfjs> | null = null;

/** pdf.js, loaded on the first PDF, with its parser on a worker thread. */
function loadPdfjs(): Promise<Pdfjs> {
  pdfjs ??= import("pdfjs-dist").then((lib) => {
    lib.GlobalWorkerOptions.workerPort = new Worker(new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url), { type: "module" });
    return lib;
  });
  return pdfjs;
}

/** Page sizes at scale 1, in CSS pixels. */
type Size = { width: number; height: number };

const GUTTER = 24;
const PAGE_GAP = 14;
/** Fit never blows a small page up past this. */
const FIT_MAX = 2;
/** Past this a page's canvas grows beyond what WebKit will allocate. */
const MAX_ZOOM = 4;

interface WorkbenchPdfViewerProps {
  bytes: ArrayBuffer;
  fileName: string;
  /** A page to show (a `file.pdf#page=4` link); each new value jumps there once. */
  page?: number | null;
  /** The page being read, as it changes. */
  onPage?: (page: number) => void;
}

export function WorkbenchPdfViewer({ bytes, fileName, page = null, onPage }: WorkbenchPdfViewerProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [doc, setDoc] = useState<{ pdf: PDFDocumentProxy; sizes: Size[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(1);
  // Where the reader was, as a share of the document, kept across a new version of the file.
  const placeRef = useRef<number | null>(null);
  // The asked-for page already jumped to: a new version of the file must not jump again.
  const jumpedRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    const scroller = scrollerRef.current;
    if (scroller && scroller.scrollHeight > scroller.clientHeight) placeRef.current = scroller.scrollTop / scroller.scrollHeight;
    loadPdfjs()
      // A copy: the worker takes ownership of the buffer it is given.
      .then((lib) => {
        task = lib.getDocument({ data: new Uint8Array(bytes.slice(0)) });
        return task.promise;
      })
      .then(async (pdf) => {
        // shortcut: every page's size up front, so the scroll height is right at once; fine to a few hundred pages.
        const pages = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)));
        const sizes = pages.map((page) => {
          const { width, height } = page.getViewport({ scale: 1 });
          return { width, height };
        });
        if (cancelled) return;
        setError(null);
        setDoc({ pdf, sizes });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        const name = reason && typeof reason === "object" && "name" in reason ? String(reason.name) : "";
        setError(name === "PasswordException" ? "This PDF is password-protected." : "This PDF could not be read.");
      });
    return () => {
      cancelled = true;
      void (task as PDFDocumentLoadingTask | null)?.destroy();
    };
  }, [bytes]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () => setWidth(scroller.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);

  const widest = doc ? Math.max(...doc.sizes.map((size) => size.width)) : 1;
  const fit = Math.min(FIT_MAX, Math.max(0.1, (width - GUTTER * 2) / widest));
  const scale = zoom === "fit" ? fit : zoom;

  // Back to the same place once the new version (or a new zoom) is laid out.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || placeRef.current === null || !doc) return;
    scroller.scrollTop = placeRef.current * scroller.scrollHeight;
    placeRef.current = null;
  }, [doc, scale]);

  const zoomTo = (next: "fit" | number) => {
    const scroller = scrollerRef.current;
    if (scroller) placeRef.current = scroller.scrollTop / Math.max(1, scroller.scrollHeight);
    setZoom(next === "fit" ? "fit" : Math.min(MAX_ZOOM, clampZoom(next)));
  };
  const zoomRef = useRef({ zoomTo, scale });
  useLayoutEffect(() => {
    zoomRef.current = { zoomTo, scale };
  });

  // Pinch (a ctrl + wheel in WebKit) and ⌘ + wheel zoom. Native: React's wheel listener is passive.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const { zoomTo: to, scale: now } = zoomRef.current;
      to(now * Math.exp(-event.deltaY * 0.01));
    };
    scroller.addEventListener("wheel", onWheel, { passive: false });
    return () => scroller.removeEventListener("wheel", onWheel);
  }, []);

  const goTo = (to: number) => {
    const target = scrollerRef.current?.querySelector(`[data-page="${to}"]`);
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!doc || !scroller || !page || page === jumpedRef.current) return;
    jumpedRef.current = page;
    const target = scroller.querySelector<HTMLElement>(`[data-page="${Math.min(page, doc.sizes.length)}"]`);
    if (target) scroller.scrollTop = target.offsetTop - GUTTER;
    placeRef.current = null;
  }, [doc, page]);

  useEffect(() => {
    if (doc) onPage?.(current);
  }, [current, doc, onPage]);

  const onScroll = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    // The page under the upper third of the view is the one being read.
    const line = scroller.scrollTop + scroller.clientHeight / 3;
    let reading = 1;
    for (const el of scroller.querySelectorAll<HTMLElement>("[data-page]")) {
      if (el.offsetTop > line) break;
      reading = Number(el.dataset.page);
    }
    setCurrent(reading);
  };

  const pages = doc?.pdf.numPages ?? 0;
  const zoomLabel = zoom === "fit" ? "Fit" : `${Math.round(scale * 100)}%`;

  return (
    <div className="codespace-media-viewer codespace-pdf" data-testid="workbench-media-preview">
      <div
        ref={scrollerRef}
        className="codespace-pdf-scroller"
        tabIndex={0}
        role="document"
        aria-label={`${fileName}. Plus and minus zoom, 0 fits the width.`}
        onScroll={onScroll}
        onKeyDown={(event) => {
          if (event.altKey) return;
          const key = event.key;
          if (key === "+" || key === "=") zoomTo(stepZoom(scale, 1));
          else if (key === "-" || key === "_") zoomTo(stepZoom(scale, -1));
          else if (key === "0") zoomTo("fit");
          else return;
          event.preventDefault();
        }}
      >
        {error && <p className="codespace-pdf-error">{error}</p>}
        {!doc && !error && (
          <div className="codespace-pdf-pages" aria-hidden>
            <div className="codespace-pdf-page codespace-pdf-page--loading" style={{ width: width - GUTTER * 2, aspectRatio: "1 / 1.294" }} />
          </div>
        )}
        {doc && (
          <div className="codespace-pdf-pages" style={{ gap: PAGE_GAP }}>
            {doc.sizes.map((size, i) => (
              <PdfPage key={i} pdf={doc.pdf} number={i + 1} size={size} scale={scale} />
            ))}
          </div>
        )}
      </div>
      {doc && (
        <div className="codespace-media-toolbar codespace-pdf-toolbar" role="toolbar" aria-label="PDF">
          <button type="button" className="codespace-workbench-toolbar-button" onClick={() => goTo(current - 1)} disabled={current <= 1} aria-label="Previous page">
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <span className="codespace-pdf-count" aria-live="polite">
            {current} / {pages}
          </span>
          <button type="button" className="codespace-workbench-toolbar-button" onClick={() => goTo(current + 1)} disabled={current >= pages} aria-label="Next page">
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <span className="codespace-media-toolbar-divider" aria-hidden="true" />
          <button type="button" className="codespace-workbench-toolbar-button" onClick={() => zoomTo(stepZoom(scale, -1))} aria-label="Zoom out" title="Zoom out (−)">
            <Minus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className="codespace-media-zoom-label"
            onClick={() => zoomTo(zoom === "fit" ? 1 : "fit")}
            aria-label={`Zoom ${zoomLabel}. ${zoom === "fit" ? "Show actual size" : "Fit to width"}`}
            title={zoom === "fit" ? "Actual size" : "Fit to width (0)"}
          >
            {zoomLabel}
          </button>
          <button type="button" className="codespace-workbench-toolbar-button" onClick={() => zoomTo(stepZoom(scale, 1))} aria-label="Zoom in" title="Zoom in (+)">
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={cn("codespace-workbench-toolbar-button", zoom === "fit" && "codespace-workbench-toolbar-button--preview-on")}
            onClick={() => zoomTo("fit")}
            aria-label="Fit to width"
            title="Fit to width (0)"
          >
            <Maximize className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

/** One page: a sized slot always, its canvas and selectable text once it nears the view. */
function PdfPage({ pdf, number, size, scale }: { pdf: PDFDocumentProxy; number: number; size: Size; scale: number }) {
  const slotRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: "800px 0px" });
    observer.observe(slot);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const text = textRef.current;
    if (!near || !canvas || !text) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;
    let page: PDFPageProxy | null = null;
    void (async () => {
      const lib = await loadPdfjs();
      page = await pdf.getPage(number);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const ratio = window.devicePixelRatio || 1;
      // Drawn off-screen first, so a zoom swaps pages in sharp instead of blanking them.
      const next = document.createElement("canvas");
      next.width = Math.floor(viewport.width * ratio);
      next.height = Math.floor(viewport.height * ratio);
      const render = page.render({ canvas: next, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      task = render;
      await render.promise;
      if (cancelled) return;
      canvas.width = next.width;
      canvas.height = next.height;
      canvas.getContext("2d")?.drawImage(next, 0, 0);
      setDrawn(true);
      text.replaceChildren();
      const layer = new lib.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
      task = layer;
      await layer.render();
    })().catch(() => {
      // A cancelled render (a zoom or scroll away) rejects; the next one takes over.
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, pdf, number, scale]);

  return (
    <div
      ref={slotRef}
      data-page={number}
      className={cn("codespace-pdf-page", !drawn && "codespace-pdf-page--loading")}
      style={{
        width: Math.floor(size.width * scale),
        height: Math.floor(size.height * scale),
        ["--total-scale-factor" as string]: scale,
      }}
      aria-label={`Page ${number}`}
    >
      <canvas ref={canvasRef} className="codespace-pdf-canvas" />
      <div ref={textRef} className="textLayer" />
    </div>
  );
}

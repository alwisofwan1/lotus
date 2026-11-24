"use client";

// occlusion-exempt: this listbox renders only inside CanvasesModal, which holds
// the occlusion lock for the whole overlay — the WebView is already parked while
// the gallery is on screen, so it needs no lock of its own.
import { useCallback, useEffect, useRef, useState, type Ref } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { Plus } from "lucide-react";
import {
  codecanvasLoadProject,
  type CodeCanvasProjectMeta,
  type CodeCanvasProjectSnapshot,
} from "@/lib/tauri/codecanvas";
import { CanvasMiniMap } from "./CanvasMiniMap";

type SnapState = "loading" | "ready" | "error";
interface SnapEntry {
  state: SnapState;
  snapshot: CodeCanvasProjectSnapshot | null;
}

function projectLabel(project: CodeCanvasProjectMeta): string {
  return project.alias || project.rootDir.split(/[\\/]/).filter(Boolean).at(-1) || project.rootDir;
}

/** Stable 32-bit hash → a calm, low-saturation accent hue per canvas. */
function accentFor(id: string): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  return `hsl(${hue} 42% 62%)`;
}

interface Props {
  projects: CodeCanvasProjectMeta[];
  activeProjectId: string | null;
  nodeCountsByProject: Map<string, number>;
  onOpen: (projectId: string) => void;
  onCreate: () => void;
}

/**
 * Embla-powered horizontal canvas selector. Each slide is a flat portrait card
 * showing a real miniature of that canvas's node graph (lazily loaded). A
 * subtle center-focus scale/dim is driven by Embla's scrollProgress vs each
 * slide's snap position — no 3D theatrics.
 */
export function CanvasGallery({ projects, activeProjectId, nodeCountsByProject, onOpen, onCreate }: Props) {
  const [mounted, setMounted] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const ordered = [...projects].sort((a, b) => b.updatedAt - a.updatedAt);

  const [emblaRef, emblaApi] = useEmblaCarousel({
    align: "center",
    containScroll: false,
    dragFree: false,
    loop: false,
    skipSnaps: false,
  });

  const slideRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelLockRef = useRef(false);

  const [snaps, setSnaps] = useState<Map<string, SnapEntry>>(new Map());
  const loadingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const raf = requestAnimationFrame(() => {
      setMounted(true);
      setReducedMotion(mq.matches);
    });
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => {
      cancelAnimationFrame(raf);
      mq.removeEventListener("change", onChange);
      if (openTimerRef.current) clearTimeout(openTimerRef.current);
    };
  }, []);

  // Lazily load each project's snapshot once, cached by id. Bounded: each id is
  // fetched at most once (loadingRef guard); cards never block render on it.
  const ensureSnapshot = useCallback((projectId: string) => {
    if (loadingRef.current.has(projectId)) return;
    loadingRef.current.add(projectId);
    setSnaps((prev) => {
      if (prev.has(projectId)) return prev;
      const next = new Map(prev);
      next.set(projectId, { state: "loading", snapshot: null });
      return next;
    });
    codecanvasLoadProject(projectId)
      .then((snapshot) => {
        setSnaps((prev) => {
          const next = new Map(prev);
          next.set(projectId, { state: "ready", snapshot });
          return next;
        });
      })
      .catch(() => {
        setSnaps((prev) => {
          const next = new Map(prev);
          next.set(projectId, { state: "error", snapshot: null });
          return next;
        });
      });
  }, []);

  // Center-focus: scale/dim each slide by its snap distance from the current
  // scroll position. Cheap DOM writes on Embla scroll/reInit.
  const applyFocus = useCallback(() => {
    if (!emblaApi) return;
    if (reducedMotion) {
      for (const el of slideRefs.current) {
        if (el) {
          el.style.transform = "";
          el.style.opacity = "";
        }
      }
      return;
    }
    const progress = emblaApi.scrollProgress();
    const snapList = emblaApi.scrollSnapList();
    snapList.forEach((snap, i) => {
      const el = slideRefs.current[i];
      if (!el) return;
      const dist = Math.min(1, Math.abs(snap - progress) * snapList.length);
      const scale = 1 - dist * 0.12; // center ~1.0, neighbors ~0.9
      const opacity = 1 - dist * 0.45;
      el.style.transform = `scale(${scale.toFixed(4)})`;
      el.style.opacity = opacity.toFixed(3);
    });
  }, [emblaApi, reducedMotion]);

  useEffect(() => {
    if (!emblaApi) return;
    applyFocus();
    emblaApi.on("scroll", applyFocus);
    emblaApi.on("reInit", applyFocus);
    return () => {
      emblaApi.off("scroll", applyFocus);
      emblaApi.off("reInit", applyFocus);
    };
  }, [emblaApi, applyFocus]);

  // Translate vertical wheel into horizontal slide navigation (simple + clean).
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!emblaApi) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(delta) < 8 || wheelLockRef.current) return;
      wheelLockRef.current = true;
      if (delta > 0) emblaApi.scrollNext();
      else emblaApi.scrollPrev();
      window.setTimeout(() => {
        wheelLockRef.current = false;
      }, 220);
    },
    [emblaApi],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!emblaApi) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        emblaApi.scrollNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        emblaApi.scrollPrev();
      }
    },
    [emblaApi],
  );

  const handleOpen = useCallback(
    (id: string) => {
      if (openingId) return;
      setOpeningId(id);
      const delay = reducedMotion ? 0 : 340;
      openTimerRef.current = setTimeout(() => onOpen(id), delay);
    },
    [onOpen, openingId, reducedMotion],
  );

  if (!mounted) {
    return <div className="canvas-gallery-stage" aria-hidden />;
  }

  if (ordered.length === 0) {
    return (
      <div className="canvas-gallery-stage">
        <div className="canvas-gallery-empty">
          <p>No canvases yet.</p>
          <button type="button" className="canvas-gallery-new" onClick={onCreate}>
            <Plus size={14} strokeWidth={1.75} /> New canvas
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`canvas-gallery-stage${openingId ? " is-opening" : ""}`}>
      <div
        className="canvas-gallery-viewport"
        ref={emblaRef}
        role="listbox"
        aria-label="Canvases gallery"
        aria-orientation="horizontal"
        tabIndex={0}
        onWheel={onWheel}
        onKeyDown={onKeyDown}
      >
        <div className="canvas-gallery-container">
          {ordered.map((project, i) => {
            const active = project.id === activeProjectId;
            const opening = project.id === openingId;
            const count = nodeCountsByProject.get(project.id) ?? 0;
            const accent = accentFor(project.id);
            return (
              <CanvasGallerySlide
                key={project.id}
                cardRef={(el) => {
                  slideRefs.current[i] = el;
                }}
                project={project}
                label={projectLabel(project)}
                accent={accent}
                active={active}
                opening={opening}
                count={count}
                entry={snaps.get(project.id)}
                ensureSnapshot={ensureSnapshot}
                onActivate={() => handleOpen(project.id)}
              />
            );
          })}
        </div>
      </div>

      <p className="canvas-gallery-hint" aria-hidden>
        scroll or drag to browse · click to open
      </p>
    </div>
  );
}

interface SlideProps {
  project: CodeCanvasProjectMeta;
  label: string;
  accent: string;
  active: boolean;
  opening: boolean;
  count: number;
  entry: SnapEntry | undefined;
  ensureSnapshot: (id: string) => void;
  onActivate: () => void;
  cardRef: Ref<HTMLButtonElement>;
}

function CanvasGallerySlide({
  project,
  label,
  accent,
  active,
  opening,
  count,
  entry,
  ensureSnapshot,
  onActivate,
  cardRef,
}: SlideProps) {
  // Kick off the snapshot load on first mount; cached thereafter.
  useEffect(() => {
    ensureSnapshot(project.id);
  }, [ensureSnapshot, project.id]);

  const downRef = useRef<{ x: number; y: number } | null>(null);
  const ready = entry?.state === "ready";
  const loading = !entry || entry.state === "loading";

  return (
    <div className="canvas-gallery-slide">
      <button
        ref={cardRef}
        type="button"
        role="option"
        aria-selected={active}
        aria-current={active ? "page" : undefined}
        aria-label={`Open ${label}`}
        title={project.rootDir}
        className={`canvas-gallery-card${active ? " is-current" : ""}${opening ? " is-opening" : ""}`}
        onPointerDown={(e) => {
          downRef.current = { x: e.clientX, y: e.clientY };
        }}
        onClick={(e) => {
          // Suppress the click that ends a drag (moved more than a few px).
          const start = downRef.current;
          downRef.current = null;
          if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) return;
          onActivate();
        }}
      >
        <div
          className="canvas-gallery-thumb"
          style={{ "--card-accent": accent } as React.CSSProperties}
          aria-hidden
        >
          {active ? <span className="canvas-gallery-current">● Current</span> : null}
          {loading ? (
            <span className="canvas-gallery-skeleton" />
          ) : ready && entry?.snapshot ? (
            <CanvasMiniMap nodes={entry.snapshot.nodes} edges={entry.snapshot.edges} accent={accent} />
          ) : (
            <CanvasMiniMap nodes={[]} edges={[]} accent={accent} />
          )}
          {count > 0 ? <span className="canvas-gallery-count">{count}</span> : null}
        </div>
        <span className="canvas-gallery-name">{label}</span>
      </button>
    </div>
  );
}

"use client";
import { Suspense, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { X, Maximize2, Minimize2 } from "lucide-react";
import type { SettingsSectionEntry } from "../settings-sections";

interface Props {
  open: boolean;
  onClose: () => void;
  sections: readonly SettingsSectionEntry[];
  activeId: string;
  onSelect: (id: string) => void;
  /** The canvas's resolved Canvas Style (`--ct-*`), when the modal opens over the canvas. */
  themeStyle?: CSSProperties;
  themeAttributes?: Record<`data-${string}`, string | undefined>;
}

/** Lotus Settings: one modal for every mode, with liquid-glass chrome and maximize support. */
export function LotusSettingsModal({ open, onClose, sections, activeId, onSelect, themeStyle, themeAttributes }: Props) {
  const [isMaximized, setIsMaximized] = useState(false);
  // One scroll container is shared across sections, so switching would otherwise inherit the
  // previous section's scroll offset (a new section opening mid-page). Reset to the top on change.
  const bodyRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Take focus while open, so a focused terminal stops receiving keys (Escape, typing), and hand
  // it back on close.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    railRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    // scrollTo isn't implemented in jsdom; fall back to the always-present scrollTop.
    if (typeof body.scrollTo === "function") body.scrollTo({ top: 0 });
    else body.scrollTop = 0;
  }, [activeId, open]);

  if (!open || sections.length === 0) return null;

  const active = sections.find((s) => s.id === activeId) ?? sections[0];
  // One flat list in registry order, which is also what the arrow keys walk.
  const ordered = sections;

  const onRailKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const index = ordered.findIndex((s) => s.id === active.id);
    const next =
      event.key === "ArrowDown" ? ordered[Math.min(index + 1, ordered.length - 1)]
      : event.key === "ArrowUp" ? ordered[Math.max(index - 1, 0)]
      : event.key === "Home" ? ordered[0]
      : event.key === "End" ? ordered[ordered.length - 1]
      : null;
    if (!next) return;
    event.preventDefault();
    onSelect(next.id);
    railRef.current?.querySelector<HTMLElement>(`[data-section-id="${next.id}"]`)?.focus();
  };

  return (
    // `codecanvas-shell` puts the Canvas Style tokens in scope; `.lotus-settings-scope` makes the
    // wrapper box-less, so none of the canvas shell's own layout applies to it.
    <div className="codecanvas-shell lotus-settings-scope" style={themeStyle} {...themeAttributes}>
      <div
        className="canvas-settings-backdrop"
        data-maximized={isMaximized ? "true" : undefined}
        onPointerDown={onClose}
      >
        <div
          className="canvas-settings-surface"
          role="dialog"
          aria-modal="true"
          aria-label="Lotus settings"
          data-maximized={isMaximized ? "true" : undefined}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* Window chrome */}
          <div className="cs-chrome">
            <span className="cs-chrome-title">Lotus · Settings</span>
            <div className="cs-chrome-actions" role="group" aria-label="Window controls">
              <button
                type="button"
                className="cs-chrome-btn"
                aria-label={isMaximized ? "Restore window" : "Maximize window"}
                onClick={() => setIsMaximized((m) => !m)}
              >
                {isMaximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
              <button
                type="button"
                className="cs-chrome-btn cs-chrome-btn--close"
                aria-label="Close settings"
                onClick={onClose}
              >
                <X size={12} />
              </button>
            </div>
          </div>

          {/* Left navigation rail */}
          <nav className="canvas-settings-rail" aria-label="Settings sections">
            <div
              ref={railRef}
              className="canvas-settings-rail-items"
              role="tablist"
              aria-orientation="vertical"
              onKeyDown={onRailKeyDown}
            >
              {ordered.map((s) => {
                const Icon = s.icon;
                const selected = s.id === active.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    data-section-id={s.id}
                    className="canvas-settings-rail-item"
                    data-selected={selected ? "true" : undefined}
                    onClick={() => onSelect(s.id)}
                  >
                    <Icon size={13} aria-hidden />
                    <span className="canvas-settings-rail-item-label">{s.title}</span>
                  </button>
                );
              })}
            </div>
          </nav>

          {/* Main content */}
          <section className="canvas-settings-content" role="tabpanel" aria-label={active.title}>
            <header className="canvas-settings-content-head">
              <h2 className="canvas-settings-content-title">{active.title}</h2>
            </header>
            <div className="canvas-settings-content-body" ref={bodyRef}>
              <Suspense fallback={null}>{active.render()}</Suspense>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

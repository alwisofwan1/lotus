"use client";
import { memo, type Ref } from "react";
import { TerminalSearchBar } from "@/modules/codespace/components/TerminalSearchBar";
import { CanvasNodeGlyph, type CanvasGlyphTone } from "./CanvasNodeGlyph";
import type { CanvasSearchAPI } from "../../hooks/useCanvasTerminalNode";

export interface CanvasPtySearch {
  api: CanvasSearchAPI;
  onClose: () => void;
}

export interface CanvasPtyRecovery {
  title: string;
  sub: string;
  /** Button label, e.g. "Restart terminal". */
  recoverLabel: string;
  /** Omitted = no restart action available (e.g. no dispatch command wired). */
  onRecover?: () => void;
}

export interface CanvasPtyGlyph {
  label: string;
  tone: CanvasGlyphTone;
  detail?: string;
  /** Per-node testid (e.g. "canvas-terminal-glyph-cover"). */
  testId: string;
}

export interface CanvasPtyViewportProps {
  /** The xterm host element ref — the only runtime coupling, fed by any PTY runtime (legacy or v2). */
  containerRef: Ref<HTMLDivElement>;
  /** At collapsed LOD tiers the host stays mounted but rendering pauses; a glyph cover is shown. */
  collapsed: boolean;
  search?: CanvasPtySearch | null;
  recovery?: CanvasPtyRecovery | null;
  glyph: CanvasPtyGlyph;
}

/**
 * The shared PTY rendering surface for canvas nodes (ADR-0022/0023): search bar + the
 * `canvas-terminal-viewport` (the xterm host, a recovery overlay, and a collapsed-tier glyph
 * cover). There is deliberately no wallpaper layer: xterm runs with allowTransparency:false on
 * --node-floor-solid, so anything beneath the host is unreachable (plans/canvas-terminal-opaque-
 * floor). It is purely presentational — every input arrives via props and
 * there is zero coupling to a specific PTY runtime, so a Canvas Terminal Node and a live Canvas
 * Agent Node render through the same surface, and a future Terminal v2 runtime swaps in behind
 * the same `containerRef` contract without touching this component.
 */
export const CanvasPtyViewport = memo(function CanvasPtyViewport({
  containerRef,
  collapsed,
  search,
  recovery,
  glyph,
}: CanvasPtyViewportProps) {
  return (
    <>
      {search && (
        <TerminalSearchBar
          onFind={(q) => search.api.findNext(q)}
          onFindPrev={(q) => search.api.findPrevious(q)}
          onClose={search.onClose}
        />
      )}
      <div className="canvas-terminal-viewport">
        <div ref={containerRef} className="canvas-terminal-host" />
        {recovery && !collapsed && (
          <div className="canvas-terminal-recovery" role="status">
            <p className="canvas-terminal-recovery-title">{recovery.title}</p>
            <p className="canvas-terminal-recovery-sub">{recovery.sub}</p>
            {recovery.onRecover && (
              <button type="button" className="canvas-terminal-recovery-btn" onClick={recovery.onRecover}>
                {recovery.recoverLabel}
              </button>
            )}
          </div>
        )}
        {collapsed && (
          <div className="canvas-node-glyph-cover" data-testid={glyph.testId}>
            <CanvasNodeGlyph label={glyph.label} tone={glyph.tone} detail={glyph.detail} />
          </div>
        )}
      </div>
    </>
  );
});

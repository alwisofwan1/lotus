"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { frameChipTooltip, type FrameChip } from "../services/canvas-frame-switcher";
import { MAX_FRAMES } from "../services/canvas-frames";
import { useCanvasOcclusionLock } from "../hooks/useCanvasOcclusionLock";
import { useShortcutPlatform } from "@/lib/hooks/useShortcutLabel";

interface Props {
  chips: FrameChip[];
  overflow: FrameChip[];
  onGoToFrame: (frameId: string) => void;
  onCreateFrame: () => void;
  /** The active Frame (decision 36): its chip is marked, and new nodes land in it. */
  activeFrameId?: string | null;
  /**
   * One "Frame 1 ▾" trigger instead of a chip per Frame: the docked command bar has room for the text,
   * not for a row of chips. The menu lists every Frame and "New Frame"; the trigger's dot is the
   * worst status across all of them, so a Frame that needs you still shows without opening it.
   */
  compact?: boolean;
}

/** The worst tone in a set, so a folded chip still carries a signal. */
function worstTone(list: readonly FrameChip[]): FrameChip["tone"] {
  if (list.some((c) => c.needsYou)) return "blocked";
  return list.find((c) => c.tone === "error")?.tone ?? list.find((c) => c.tone === "running")?.tone ?? "idle";
}

/**
 * Frame Switcher (ADR-0050): one chip per Frame in the command bar. Click flies the camera there;
 * the dot is the Frame's worst member status, and a "needs you" ring is paired with the word in the
 * tooltip so colour is never the only cue. Chips are hidden when there are no Frames; "+" stays.
 */
export function CanvasFrameSwitcher({ chips, overflow, onGoToFrame, onCreateFrame, activeFrameId = null, compact = false }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const platform = useShortcutPlatform();
  const tooltip = (chip: FrameChip) => frameChipTooltip(chip, platform);
  // The overflow menu floats over the canvas; park browser WebViews beneath it while it is open.
  useCanvasOcclusionLock(menuOpen, "frame-overflow-menu");

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as globalThis.Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [menuOpen]);

  // Arrow keys walk the chips (Tab reaches the group once); Enter/click activates natively.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && menuOpen) {
      setMenuOpen(false);
      return;
    }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-frame-chip]"));
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    const next = items[(at + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length];
    next?.focus();
  };

  // Decision 33: no "+" once the canvas holds the maximum.
  const atLimit = chips.length + overflow.length >= MAX_FRAMES;
  const overflowNeedsYou = overflow.some((c) => c.needsYou);
  // The worst tone among the folded Frames so the +N chip still carries a signal.
  const overflowTone = worstTone(overflow);

  const menuItem = (chip: FrameChip) => (
    <button
      key={chip.frameId}
      type="button"
      role="menuitem"
      className="canvas-frame-menu-item"
      aria-current={chip.frameId === activeFrameId ? "true" : undefined}
      onClick={() => {
        setMenuOpen(false);
        onGoToFrame(chip.frameId);
      }}
    >
      <span className="canvas-frame-menu-num">{chip.label}</span>
      <span className="canvas-frame-menu-name">{chip.name}</span>
      {chip.needsYou ? <span className="canvas-frame-menu-need">needs you</span> : null}
      <i className="canvas-frame-chip-dot" style={{ background: `var(--canvas-status-${chip.tone})` }} aria-hidden="true" />
    </button>
  );

  const addButton = atLimit ? null : (
    <button
      type="button"
      className="canvas-frame-chip canvas-frame-chip--add"
      data-frame-chip
      aria-label="New Frame"
      title="New Frame"
      onClick={onCreateFrame}
    >
      <Plus size={14} aria-hidden="true" />
    </button>
  );

  if (compact) {
    const all = [...chips, ...overflow];
    if (all.length === 0) {
      return <div className="canvas-frame-switcher" role="group" aria-label="Frames" data-testid="frame-switcher">{addButton}</div>;
    }
    const active = all.find((c) => c.frameId === activeFrameId);
    const tone = worstTone(all);
    const needsYou = all.some((c) => c.needsYou);
    return (
      <div ref={rootRef} className="canvas-frame-switcher" role="group" aria-label="Frames" data-testid="frame-switcher" onKeyDown={onKeyDown}>
        <span className="canvas-frame-overflow">
          <button
            type="button"
            className="canvas-frame-chip canvas-frame-chip--compact"
            data-needs-you={needsYou ? "true" : undefined}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Frames${active ? `, Frame ${active.label} active` : ""}${needsYou ? " · needs you" : ""}`}
            title={active ? `${tooltip(active)} · active` : `${all.length} Frames`}
            onClick={() => setMenuOpen((o) => !o)}
          >
            {tone !== "idle" ? <i className="canvas-frame-chip-dot" style={{ background: `var(--canvas-status-${tone})` }} aria-hidden="true" /> : null}
            {/* Named, not a bare digit: "1 ▾" beside the project read as a count. */}
            {active ? (/^\d+$/.test(active.label) ? `Frame ${active.label}` : active.label) : `${all.length} Frames`}
            <ChevronDown size={12} aria-hidden="true" className="canvas-frame-chip-chev" />
          </button>
          {menuOpen ? (
            <div className="canvas-frame-menu" role="menu" data-testid="frame-overflow-menu">
              {all.map(menuItem)}
              {atLimit ? null : (
                <button
                  type="button"
                  role="menuitem"
                  className="canvas-frame-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onCreateFrame();
                  }}
                >
                  <Plus size={14} aria-hidden="true" className="canvas-frame-menu-num" />
                  <span className="canvas-frame-menu-name">New Frame</span>
                </button>
              )}
            </div>
          ) : null}
        </span>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="canvas-frame-switcher"
      role="group"
      aria-label="Frames"
      data-testid="frame-switcher"
      onKeyDown={onKeyDown}
    >
      {chips.map((chip) => (
        <button
          key={chip.frameId}
          type="button"
          className="canvas-frame-chip"
          data-frame-chip
          data-needs-you={chip.needsYou ? "true" : undefined}
          aria-current={chip.frameId === activeFrameId ? "true" : undefined}
          title={chip.frameId === activeFrameId ? `${tooltip(chip)} · active` : tooltip(chip)}
          aria-label={chip.frameId === activeFrameId ? `${tooltip(chip)} · active` : tooltip(chip)}
          onClick={() => onGoToFrame(chip.frameId)}
        >
          {chip.tone !== "idle" ? <i className="canvas-frame-chip-dot" style={{ background: `var(--canvas-status-${chip.tone})` }} aria-hidden="true" /> : null}
          {chip.label}
        </button>
      ))}
      {overflow.length > 0 ? (
        <span className="canvas-frame-overflow">
          <button
            type="button"
            className="canvas-frame-chip"
            data-frame-chip
            data-needs-you={overflowNeedsYou ? "true" : undefined}
            aria-current={overflow.some((c) => c.frameId === activeFrameId) ? "true" : undefined}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={`${overflow.length} more Frames${overflowNeedsYou ? " · needs you" : ""}`}
            onClick={() => setMenuOpen((o) => !o)}
          >
            {overflowTone !== "idle" ? <i className="canvas-frame-chip-dot" style={{ background: `var(--canvas-status-${overflowTone})` }} aria-hidden="true" /> : null}
            {`+${overflow.length}`}
          </button>
          {menuOpen ? (
            <div className="canvas-frame-menu" role="menu" data-testid="frame-overflow-menu">
              {overflow.map(menuItem)}
            </div>
          ) : null}
        </span>
      ) : null}
      {addButton}
    </div>
  );
}

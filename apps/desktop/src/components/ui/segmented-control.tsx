"use client";
import { useCallback, useLayoutEffect, useEffect, useRef } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform, useVelocity } from "motion/react";

// Segmented choice whose selection is a single pill that springs between segments and stretches
// with its own speed, then settles. Adapted from Planes' free Segmented Control
// (useplanes.com/r/segmented-control.json); three deliberate departures:
//
// - NO COLOURS. Planes hard-codes zinc/white plus `dark:` variants, and Lotus defines no `dark`
//   variant, so `dark:` would follow the OS rather than the Lotus theme. This component carries
//   motion only; the skin comes from the caller's classes, which read Lotus tokens.
// - NO BLUR. Planes blurs the pill by its velocity. styles/AGENTS.md rules out default blur, and in
//   the Tauri WKWebView it shares the GPU with xterm WebGL and the canvas.
// - SEMANTICS STAY `group` + `aria-pressed`. Planes uses tablist/tab, which is wrong for a setting
//   value (no tabpanel is controlled) and would break every caller that finds buttons by pressed.
//
// The pill renders only when motion is allowed, invisible until the active segment is measured;
// measuring then sets `data-pill="on"` on the container so the skin can hand the active fill over
// to the pill. Without it (reduced motion, first paint) the active button paints its own fill, so
// the state is never invisible. Both are written imperatively from the measure pass: a state flag
// would cost a second render on mount and trips react-hooks/set-state-in-effect.

const PILL_SPRING = { stiffness: 380, damping: 24, mass: 0.6 } as const;
const WIDTH_SPRING = { stiffness: 400, damping: 28, mass: 0.5 } as const;
const PRESS_SPRING = { stiffness: 600, damping: 22, mass: 0.4 } as const;
/** Extra width (px) per px/s of pill speed, capped — the "stretch" that sells the motion. */
const STRETCH_PER_VELOCITY = 0.04;
const STRETCH_MAX_PX = 12;
const PRESSED_SCALE = 0.95;

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (next: T) => void;
  /** Accessible name of the group. */
  label: string;
  disabled?: boolean;
  className?: string;
  buttonClassName?: string;
  pillClassName?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
  className = "ui-seg",
  buttonClassName = "ui-seg-btn",
  pillClassName = "ui-seg-pill",
}: SegmentedControlProps<T>) {
  const reducedMotion = useReducedMotion() ?? false;
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const measuredOnce = useRef(false);
  const pillOpacity = useMotionValue(0);

  const activeIndex = Math.max(
    options.findIndex((o) => o.value === value),
    0,
  );

  const rawX = useMotionValue(0);
  const rawW = useMotionValue(0);
  const springX = useSpring(rawX, PILL_SPRING);
  const springW = useSpring(rawW, WIDTH_SPRING);
  const stretch = useTransform(useVelocity(springX), (v) =>
    Math.min(Math.abs(v) * STRETCH_PER_VELOCITY, STRETCH_MAX_PX),
  );
  const pillWidth = useTransform([springW, stretch], ([w, s]: number[]) => w + s);
  const pillX = useTransform([springX, stretch], ([x, s]: number[]) => Math.max(0, x - s / 2));

  const measure = useCallback(
    (snap: boolean) => {
      const btn = buttonRefs.current[activeIndex];
      const container = containerRef.current;
      if (!btn || !container) return;
      if (reducedMotion) {
        delete container.dataset.pill;
        return;
      }
      if (snap || !measuredOnce.current) {
        // jump() on both the source and the spring, or the spring animates in from 0.
        rawX.jump(btn.offsetLeft);
        rawW.jump(btn.offsetWidth);
        springX.jump(btn.offsetLeft);
        springW.jump(btn.offsetWidth);
        measuredOnce.current = true;
      } else {
        rawX.set(btn.offsetLeft);
        rawW.set(btn.offsetWidth);
      }
      pillOpacity.jump(1);
      container.dataset.pill = "on";
    },
    [activeIndex, reducedMotion, rawX, rawW, springX, springW, pillOpacity],
  );

  const optionsKey = options.map((o) => `${o.value}:${o.label}`).join("|");
  useLayoutEffect(() => {
    measure(false);
  }, [measure, optionsKey]);

  // A resize (font load, panel width) moves segments without a selection change: snap, don't glide.
  // The observer is created once and reads the latest measure through a ref. Re-creating it per
  // selection is the bug this avoids: a new ResizeObserver always fires once on observe(), so every
  // click snapped the pill straight to its target and the glide never played.
  const measureRef = useRef(measure);
  useLayoutEffect(() => {
    measureRef.current = measure;
  }, [measure]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measureRef.current(true));
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={label}
      data-disabled={disabled ? "" : undefined}
      className={className}
    >
      {reducedMotion ? null : (
        <motion.span
          aria-hidden
          className={pillClassName}
          style={{ x: pillX, width: pillWidth, opacity: pillOpacity }}
        />
      )}
      {options.map((opt, index) => (
        <SegmentButton
          key={opt.value}
          ref={(node) => {
            buttonRefs.current[index] = node;
          }}
          label={opt.label}
          active={index === activeIndex}
          disabled={disabled}
          reducedMotion={reducedMotion}
          className={buttonClassName}
          onSelect={() => onChange(opt.value)}
        />
      ))}
    </div>
  );
}

interface SegmentButtonProps {
  ref: (node: HTMLButtonElement | null) => void;
  label: string;
  active: boolean;
  disabled?: boolean;
  reducedMotion: boolean;
  className?: string;
  onSelect: () => void;
}

function SegmentButton({ ref, label, active, disabled, reducedMotion, className, onSelect }: SegmentButtonProps) {
  const press = useMotionValue(1);
  const scale = useSpring(press, PRESS_SPRING);
  const down = () => {
    if (!reducedMotion && !disabled) press.set(PRESSED_SCALE);
  };
  const up = () => press.set(1);

  return (
    <motion.button
      ref={ref}
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onSelect}
      onPointerDown={down}
      onPointerUp={up}
      onPointerLeave={up}
      onPointerCancel={up}
      style={{ scale }}
      className={className}
    >
      {label}
    </motion.button>
  );
}

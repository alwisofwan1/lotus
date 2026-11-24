"use client";
import { useEffect, useRef, type RefObject } from "react";

/**
 * Measures an element and publishes its width as a CSS custom property on `<html>`, so other chrome
 * can lay itself out around it without hardcoding a number.
 *
 * This exists because a hardcoded number already broke once. The NL bar's "bottom strip" design has
 * to stop short of the bottom-right corner controls or it lands on top of them, and the first version
 * reserved a fixed 172px measured from `.canvas-zoom-control` alone. But the real widget is
 * `.canvas-corner-bar`, which is wider and **variable**: its memory button is conditional on a project
 * being open, and the zoom label grows with the percentage. So the strip overlapped the controls the
 * moment reality drifted from the constant. Measuring removes the whole class of bug.
 *
 * Written to the document element rather than a shell node so a consumer anywhere in the tree can read
 * it, and cleared on unmount so a stale reservation can't outlive the widget it described.
 */
export function usePublishedElementWidth(ref: RefObject<HTMLElement | null>, cssVar: string): void {
  // Avoid redundant style writes: this fires on every resize frame while the window is dragged.
  const lastRef = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;

    const publish = () => {
      const width = Math.ceil(el.getBoundingClientRect().width);
      if (width === lastRef.current) return;
      lastRef.current = width;
      root.style.setProperty(cssVar, `${width}px`);
    };

    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      lastRef.current = null;
      // Drop the property entirely rather than zeroing it, so consumers fall back to their own
      // default instead of reserving no space at all.
      root.style.removeProperty(cssVar);
    };
  }, [ref, cssVar]);
}

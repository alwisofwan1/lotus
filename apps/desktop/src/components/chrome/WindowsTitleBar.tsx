"use client";

import { useEffect } from "react";
import {
  closeCurrentWindow,
  minimizeCurrentWindow,
  showWindowMenu,
  toggleCurrentWindowMaximize,
} from "@/lib/tauri-api";

/**
 * Windows only. The native title bar and the native menubar row are turned off there
 * (`windowing::apply_windows_chrome`). Instead of a title row of its own, this draws the window
 * buttons as an overlay on the app's own top bar — the macOS traffic-light model, mirrored to the
 * right — so the window has exactly one top row. Each route's top bar reserves room for it through
 * `--windows-caption-w` (globals.css) and stays the drag region.
 *
 * The app menu (File, Edit, Window, Help) folds into one button that pops the SAME native menu
 * `build_app_menu` builds, so its items, accelerator labels and handlers are not duplicated here.
 */
export function WindowsTitleBar({ height = 36 }: { height?: number }) {
  // The rest of the app reserves room for the overlay from this attribute (globals.css).
  useEffect(() => {
    document.documentElement.dataset.windowsCaption = "true";
    return () => {
      delete document.documentElement.dataset.windowsCaption;
    };
  }, []);

  return (
    <div
      className="windows-caption"
      style={{ ["--windows-caption-h" as string]: `${height}px` }}
    >
      <button
        type="button"
        aria-label="Application menu"
        title="Menu"
        className="windows-caption-menu"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          void showWindowMenu("", rect.left, rect.bottom).catch((err) =>
            console.error("[windows-caption] app menu failed", err),
          );
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M2 4h10M2 7h10M2 10h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      <button type="button" aria-label="Minimize" onClick={() => void minimizeCurrentWindow()}>
        <svg width="10" height="10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" /></svg>
      </button>
      <button type="button" aria-label="Maximize" onClick={() => void toggleCurrentWindowMaximize()}>
        <svg width="10" height="10" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" /></svg>
      </button>
      <button
        type="button"
        aria-label="Close"
        className="windows-caption-close"
        onClick={() => void closeCurrentWindow()}
      >
        <svg width="10" height="10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" /></svg>
      </button>
    </div>
  );
}

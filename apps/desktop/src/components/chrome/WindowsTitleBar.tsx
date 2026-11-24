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
 * (`windowing::apply_windows_chrome`), and this one 32px row replaces both: the app menu, a drag
 * area, and the window buttons. Each menu title pops the SAME native submenu `build_app_menu`
 * builds, so its items, accelerators labels and handlers are not duplicated here.
 */
const MENUS = ["File", "Edit", "Window", "Help"] as const;

export function WindowsTitleBar() {
  // The rest of the app sizes itself below the bar from this attribute (globals.css).
  useEffect(() => {
    document.documentElement.dataset.windowsTitlebar = "true";
    return () => {
      delete document.documentElement.dataset.windowsTitlebar;
    };
  }, []);

  return (
    <div className="windows-titlebar" data-tauri-drag-region>
      <span className="windows-titlebar-icon" aria-hidden="true" />
      <nav className="windows-titlebar-menus" aria-label="Application menu">
        {MENUS.map((menu) => (
          <button
            key={menu}
            type="button"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              void showWindowMenu(menu, rect.left, rect.bottom).catch((err) =>
                console.error(`[windows-titlebar] ${menu} menu failed`, err),
              );
            }}
          >
            {menu}
          </button>
        ))}
      </nav>
      <div className="windows-titlebar-drag" data-tauri-drag-region />
      <div className="windows-titlebar-caps">
        <button type="button" aria-label="Minimize" onClick={() => void minimizeCurrentWindow()}>
          <svg width="10" height="10" aria-hidden="true"><path d="M0 5.5h10" stroke="currentColor" /></svg>
        </button>
        <button type="button" aria-label="Maximize" onClick={() => void toggleCurrentWindowMaximize()}>
          <svg width="10" height="10" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" /></svg>
        </button>
        <button
          type="button"
          aria-label="Close"
          className="windows-titlebar-close"
          onClick={() => void closeCurrentWindow()}
        >
          <svg width="10" height="10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" /></svg>
        </button>
      </div>
    </div>
  );
}

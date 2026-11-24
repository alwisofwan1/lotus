"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Is this part of the page on screen? A hidden mode or a parked shell stays mounted at opacity 0,
 * which hides the DOM but not a native webview: the OS draws that above the page. Every native
 * webview host reads this, so a surface hidden at any level parks its browsers.
 */
const SurfaceVisibleContext = createContext(true);

/** Nests: a surface is visible only when every surface around it is too. */
export function SurfaceVisible({ visible, children }: { visible: boolean; children: ReactNode }) {
  const parent = useContext(SurfaceVisibleContext);
  return <SurfaceVisibleContext.Provider value={parent && visible}>{children}</SurfaceVisibleContext.Provider>;
}

export function useSurfaceVisible(): boolean {
  return useContext(SurfaceVisibleContext);
}

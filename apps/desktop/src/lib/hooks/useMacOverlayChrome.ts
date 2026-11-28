"use client";

import { useSyncExternalStore } from "react";
import { detectMacOverlayChrome } from "@/lib/platform";

const subscribeNever = () => () => {};
const readMacOverlayChrome = () => detectMacOverlayChrome();
const serverSnapshot = () => false;

/**
 * macOS draws its window controls on top of the page, so the title bar has to leave a hole for
 * them. Read through `useSyncExternalStore` with a `false` server snapshot: deciding this during
 * render would disagree with the server and throw the hydration away.
 */
export function useMacOverlayChrome(): boolean {
  return useSyncExternalStore(subscribeNever, readMacOverlayChrome, serverSnapshot);
}

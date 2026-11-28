/**
 * Which desktop OS this webview runs on — the one place that answers it.
 *
 * Before this module the app carried a dozen private copies of the question, each with its own
 * regex and its own source (`navigator.platform` here, `userAgent` there), and most of them could
 * only say "mac" or "not mac". Keyboard behaviour is where a wrong answer hurts — ⌘ on macOS is
 * Ctrl on Windows, and Ctrl is also what a terminal spends on control characters — so every
 * keyboard decision now asks here.
 *
 * Every function takes the raw platform string as an optional last argument. Production leaves it
 * out; tests pass `"MacIntel"` or `"Win32"` and exercise both platforms on one machine.
 */

import { isTauri } from "@/lib/tauri/runtime";

export type DesktopPlatform = "mac" | "windows" | "linux" | "unknown";

const MAC_PATTERN = /mac|iphone|ipad|ipod/i;
// Not a bare /win/: "darwin" contains it.
const WINDOWS_PATTERN = /win32|win64|windows/i;
const LINUX_PATTERN = /linux|x11/i;

/**
 * The best platform string the webview offers: `userAgentData.platform` (Chromium/WebView2),
 * then `navigator.platform` (WKWebView, still populated), then the user agent. Empty during
 * prerender, where there is no navigator.
 */
export function readPlatformString(): string {
  if (typeof navigator === "undefined") return "";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform || nav.platform || nav.userAgent || "";
}

export function detectDesktopPlatform(platform: string = readPlatformString()): DesktopPlatform {
  if (MAC_PATTERN.test(platform)) return "mac";
  if (WINDOWS_PATTERN.test(platform)) return "windows";
  if (LINUX_PATTERN.test(platform)) return "linux";
  return "unknown";
}

/** macOS (or an iOS user agent): ⌘ is the primary modifier and Ctrl is left to terminals. */
export function isMacPlatform(platform: string = readPlatformString()): boolean {
  return detectDesktopPlatform(platform) === "mac";
}

export function isWindowsPlatform(platform: string = readPlatformString()): boolean {
  return detectDesktopPlatform(platform) === "windows";
}

/**
 * The native macOS window, whose traffic lights sit over the web content and need room. False in
 * a plain browser (dev without Tauri), where there are no traffic lights to make room for.
 */
export function detectMacOverlayChrome(platform: string = readPlatformString()): boolean {
  return isTauri() && isMacPlatform(platform);
}

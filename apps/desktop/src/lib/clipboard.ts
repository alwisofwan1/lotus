import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";

/**
 * Copy text from a UI action (a menu item, a button).
 *
 * `navigator.clipboard.writeText` in WKWebView rejects with `NotAllowedError` whenever WebKit
 * does not count the call as a fresh user gesture — and a context-menu item that first closes the
 * menu and moves focus can already fall outside that window. The explorer's "Copy Path" surfaced
 * exactly that string to the user. The Tauri clipboard plugin is a native call with no gesture
 * rule, so it is tried first; the browser API stays as the plain-browser (dev) fallback.
 *
 * Same plugin command as `terminal-clipboard-provider.ts`, which documents the argument shape.
 * Rejects only when both paths refused; callers decide how to say so.
 */
export async function copyTextToClipboard(
  text: string,
  {
    invoke = tauriInvoke,
    inTauri = isTauri,
    browserWrite = (value: string) => navigator.clipboard.writeText(value),
  }: {
    invoke?: typeof tauriInvoke;
    inTauri?: () => boolean;
    browserWrite?: (text: string) => Promise<void>;
  } = {},
): Promise<void> {
  if (inTauri()) {
    try {
      await invoke("plugin:clipboard-manager|write_text", { text });
      return;
    } catch {
      // Fall through to the browser API.
    }
  }
  await browserWrite(text);
}

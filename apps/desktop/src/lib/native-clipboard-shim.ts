import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";

/**
 * Routes the page's clipboard WRITES to the Tauri clipboard plugin, which needs no user gesture.
 *
 * WKWebView answers `navigator.clipboard.write*` with `NotAllowedError` whenever WebKit does not
 * count the call as a fresh gesture. The loudest caller is Monaco itself (0.55.1,
 * `BrowserClipboardService.installWebKitWriteTextWorkaround`): on WebKit it calls
 * `clipboard.write([ClipboardItem({"text/plain": <pending promise>})])` on EVERY click and keydown
 * inside an editor, so a later copy can fill that promise in. Monaco only swallows the rejection
 * when it cancelled the promise itself; every other refusal is `logService.error`-ed — the
 * `[browser] ERR NotAllowedError … at write` line in the dev terminal.
 *
 * With the shim, a text write waits for its text and hands it to the native clipboard:
 * - Monaco's pre-armed write resolves when Monaco copies, and is dropped silently when Monaco
 *   cancels it (the next click) — a copy that never happened is not an error.
 * - Every other `navigator.clipboard.writeText` in the app gets the same gesture-free path.
 *
 * Non-text writes (images) and READS keep the browser behaviour.
 */

const WRITE_TEXT_COMMAND = "plugin:clipboard-manager|write_text";
const INSTALLED = Symbol.for("lotus.nativeClipboardShim");

type ClipboardLike = Pick<Clipboard, "write" | "writeText"> & { [INSTALLED]?: true };

export function installNativeClipboardShim({
  clipboard = typeof navigator === "undefined" ? undefined : (navigator.clipboard as ClipboardLike | undefined),
  invoke = tauriInvoke,
  inTauri = isTauri,
}: {
  clipboard?: ClipboardLike;
  invoke?: typeof tauriInvoke;
  inTauri?: () => boolean;
} = {}): void {
  if (!clipboard || !inTauri() || clipboard[INSTALLED]) return;

  const browserWrite = clipboard.write?.bind(clipboard);
  const browserWriteText = clipboard.writeText?.bind(clipboard);
  const writeNative = (text: string) => invoke(WRITE_TEXT_COMMAND, { text });

  const writeText = async (text: string): Promise<void> => {
    try {
      await writeNative(text);
    } catch {
      if (!browserWriteText) throw new DOMException("Clipboard unavailable", "NotAllowedError");
      await browserWriteText(text);
    }
  };

  const write = async (items: ClipboardItems): Promise<void> => {
    const [item] = items;
    if (items.length !== 1 || !item?.types.includes("text/plain")) {
      if (!browserWrite) throw new DOMException("Clipboard unavailable", "NotAllowedError");
      return browserWrite(items);
    }
    let text: string;
    try {
      const data: unknown = await item.getType("text/plain");
      text = typeof data === "string" ? data : await (data as Blob).text();
    } catch {
      // The item's promise was cancelled (Monaco's pre-armed write, superseded by the next
      // click): nothing was copied, and nobody is waiting for an error.
      return;
    }
    await writeText(text);
  };

  try {
    Object.defineProperty(clipboard, "writeText", { value: writeText, configurable: true, writable: true });
    Object.defineProperty(clipboard, "write", { value: write, configurable: true, writable: true });
    Object.defineProperty(clipboard, INSTALLED, { value: true });
  } catch {
    // A clipboard object that refuses own properties keeps the browser behaviour.
  }
}

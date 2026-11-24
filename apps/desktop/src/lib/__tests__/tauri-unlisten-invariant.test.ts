import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");

/** The helper itself, and tests that deliberately construct raw unlisteners. */
const EXEMPT = [/tauri-listener-cleanup\.ts$/, /[\\/]__tests__[\\/]/, /\.test\.tsx?$/];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * A direct call to a Tauri unlisten handle, in every shape the codebase uses:
 * `unlisten()`, `unlisten?.()`, `unlistenRef.current()`, `unlistenRef.current?.()`.
 *
 * The optional-chaining forms must be included explicitly — an earlier version of this pattern
 * required `?(` and so silently missed every `?.()` call site, which is most of them. A leaky
 * invariant is worse than none: it reports green while the bug ships.
 */
const RAW_UNLISTEN = /\bunlisten[A-Za-z]*(?:\.current)?(?:\?\.)?\(\)/;

/**
 * And matching on the NAME is itself a leak, which is how six call sites shipped anyway.
 *
 * A handle bound as `off`, `next`, `un`, `open` or `navigate` is the same object as one bound as
 * `unlisten`; the 2026-09-20 Canvas crash was `off()` in `subscribeCanvasPaneTurn`. So the second
 * pass ignores names entirely: it finds whatever a file binds from `await listen(...)` /
 * `await once(...)` and then flags a bare call of that binding.
 */
const LISTEN_BINDING = /(?:const|let|var)\s+(\w+)\s*(?::[^=]+?)?=\s*await\s+(?:listen|once)\b/g;

function listenBindings(source: string): string[] {
  return [...source.matchAll(LISTEN_BINDING)].map((match) => match[1]);
}

describe("Tauri unlisten cleanup invariant", () => {
  // Calling a Tauri unlisten whose registry entry is already gone throws from inside the injected
  // WebView script — `undefined is not an object (evaluating 'listeners[eventId].handlerId')`. It
  // happens on WebView teardown and on HMR effect re-runs, and it happens inside a React CLEANUP
  // function, where a throw can break the rest of the unmount and orphan the listeners that were
  // supposed to be released next.
  //
  // `safeTauriUnlisten` exists for exactly this and is already used across the app. The failure mode
  // is not the helper being wrong, it is a new call site forgetting it — which no unit test of a
  // single hook can catch. This is the guard for that.
  it("routes every unlisten call through safeTauriUnlisten", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      if (EXEMPT.some((pattern) => pattern.test(file))) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!RAW_UNLISTEN.test(line)) return;
        if (line.includes("safeTauriUnlisten")) return;
        offenders.push(`${relative(SRC, file)}:${index + 1} → ${line.trim()}`);
      });
    }

    expect(offenders, `Wrap these in safeTauriUnlisten():\n${offenders.join("\n")}`).toEqual([]);
  });

  /**
   * Why a bare call is not merely untidy: the handle `listen` resolves to is
   * `async () => _unlisten(event, eventId)` (verified in the served bundle of
   * @tauri-apps/api v2). A registry entry that is already gone therefore comes back as a
   * REJECTED PROMISE — `undefined is not an object (evaluating 'listeners[eventId].handlerId')` —
   * which the try/catch these call sites sit inside cannot catch. It reaches the window as an
   * unhandled rejection and Next's dev overlay shows it as a runtime error over the whole app.
   * `safeTauriUnlisten` is the only caller that attaches the `.catch()`.
   */
  it("catches handles that were bound under another name", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      if (EXEMPT.some((pattern) => pattern.test(file))) continue;
      const source = readFileSync(file, "utf8");
      const bindings = listenBindings(source);
      if (bindings.length === 0) continue;

      source.split("\n").forEach((line, index) => {
        if (line.includes("safeTauriUnlisten")) return;
        for (const name of bindings) {
          if (new RegExp(`\\b${name}(?:\\?\\.)?\\(\\)`).test(line)) {
            offenders.push(`${relative(SRC, file)}:${index + 1} → ${line.trim()}`);
            return;
          }
        }
      });
    }

    expect(offenders, `Wrap these in safeTauriUnlisten():\n${offenders.join("\n")}`).toEqual([]);
  });

  /**
   * `Webview.onDragDropEvent` hands back an unlisten that fires four async unlistens without
   * awaiting them, so wrapping it in `safeTauriUnlisten` does not help: the stale-listener throw
   * becomes an unhandled rejection (the 2026-10-19 Canvas drag-drop crash). Use
   * `listenWebviewDragDrop` instead.
   */
  it("never calls Webview.onDragDropEvent directly", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (EXEMPT.some((pattern) => pattern.test(file))) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (/\.onDragDropEvent\(/.test(line)) offenders.push(`${relative(SRC, file)}:${index + 1} → ${line.trim()}`);
      });
    }
    expect(offenders, `Use listenWebviewDragDrop():\n${offenders.join("\n")}`).toEqual([]);
  });
});

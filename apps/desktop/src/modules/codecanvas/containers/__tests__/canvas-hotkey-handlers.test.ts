import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_VOICE_HOTKEY_IDS, CANVAS_HOTKEY_COMMANDS } from "../../services/canvas-hotkeys";

/**
 * Every command the hotkey registry advertises must be driven by the registry.
 *
 * This exists because `jump-labels` was not, for months. It sat in the registry on `f`, appeared in
 * Settings → Hotkeys as a rebindable row with a title and a chord, and pressing it did nothing —
 * `useCanvasHotkeys` returns before `preventDefault` when a command has no handler, so the key was
 * not even swallowed. Nothing failed and nothing warned.
 *
 * A source-level check, in the same spirit as `tauri-command-permissions.test.ts`: the registry and
 * its handler maps live in different files and nothing else makes them agree. A runtime test would
 * have to know to press every chord, which is exactly the knowledge that was missing.
 */

/** Every file that hands handlers to `useCanvasHotkeys`. There is more than one on purpose. */
const CONSUMERS = [
  "src/modules/codecanvas/containers/CanvasPage.tsx",
  "src/modules/codecanvas/services/voice/use-canvas-turn-voice-controller.ts",
];

/**
 * Structural keys: documented by the registry, dispatched by their own listener.
 *
 *   ⌘K       — `useCanvasCommandSheet` owns mod+k (inside CanvasNlCommandBar since the
 *              centred palette merged into the command bar)
 *   settings — `LotusSettingsProvider` owns mod+, app-wide (ADR-0054)
 *   group    — `CanvasPage`'s own listener owns mod+g
 *
 * This is legitimate, and an earlier version of this comment said otherwise — it claimed the Settings
 * rows lied about being remappable. They do not: all three are `fixed: true`, and `HotkeysTab` sets
 * `aria-disabled` and refuses the click for a fixed row. The registry entry is there to SHOW the
 * chord, not to route it.
 *
 * Which is exactly why the invariant below matters. `fixed` is what makes an exception honest, and
 * `jump-labels` had no `fixed` flag at all — a rebindable row with no handler. Pinning the flag stops
 * this list from quietly absorbing the next one of those.
 */
const DISPATCHED_ELSEWHERE = ["palette", "settings", "group"];

/**
 * The app-level voice keys are rebindable rows routed by the Voice Core listener (they work in every
 * mode), so canvas claims them with `useVoiceHotkeyHandlers`, not `useCanvasHotkeys`.
 */
const APP_VOICE_IDS = Object.keys(APP_VOICE_HOTKEY_IDS);
const VOICE_CLAIM_FILE = "src/modules/codecanvas/services/voice/use-canvas-turn-voice-controller.ts";

describe("canvas hotkey handlers", () => {
  const handlerBlocks = CONSUMERS.map((path) => {
    const src = readFileSync(resolve(process.cwd(), path), "utf8");
    // Everything from the first `useCanvasHotkeys({` on, which is where handlers are declared.
    const at = src.indexOf("useCanvasHotkeys({");
    expect(at, `${path} no longer calls useCanvasHotkeys`).toBeGreaterThan(-1);
    return src.slice(at);
  }).join("\n");

  it("registers a handler for every command the registry advertises", () => {
    const missing = CANVAS_HOTKEY_COMMANDS.map((command) => command.id)
      .filter((id) => !DISPATCHED_ELSEWHERE.includes(id) && !APP_VOICE_IDS.includes(id))
      .filter((id) => !handlerBlocks.includes(`"${id}":`));

    expect(missing).toEqual([]);
  });

  it("claims both app voice keys through the Voice Core listener", () => {
    const src = readFileSync(resolve(process.cwd(), VOICE_CLAIM_FILE), "utf8");
    const claim = src.slice(src.indexOf("useVoiceHotkeyHandlers({"));
    expect(claim.length, "canvas no longer claims the app voice keys").toBeGreaterThan(0);
    expect(APP_VOICE_IDS).toEqual(["app-voice-push-to-talk", "app-voice-live"]);
    expect(claim.slice(0, 200)).toMatch(/pushToTalk:[\s\S]*liveVoice:/);
  });

  it("only excuses reserved bindings, never a rebindable one", () => {
    // The invariant that would have caught `jump-labels` even if someone had excused it: a row the
    // operator can remap must be routed by the registry, or remapping it does nothing.
    const rebindable = DISPATCHED_ELSEWHERE.filter(
      (id) => !CANVAS_HOTKEY_COMMANDS.find((command) => command.id === id)?.fixed,
    );

    expect(rebindable).toEqual([]);
  });

  it("drops an entry that has since been wired properly", () => {
    // Otherwise the exception outlives its reason and starts hiding a real gap again.
    const nowWired = DISPATCHED_ELSEWHERE.filter((id) => handlerBlocks.includes(`"${id}":`));

    expect(nowWired).toEqual([]);
  });

  it("has commands to check, so a broken read cannot pass silently", () => {
    expect(CANVAS_HOTKEY_COMMANDS.length).toBeGreaterThan(10);
    expect(handlerBlocks).toContain("useCanvasHotkeys({");
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// plans/nl-type-to-focus: "/" is registered as a named hotkey command (focus-command-bar) so it shows
// up in Settings → Hotkeys and stays remappable, rather than being sniffed out of a bare keydown
// listener. CanvasPage is the window where useCanvasHotkeys is wired — asserted against source text
// (see chrome-wiring.test.ts / tool-shortcut-gating.test.ts in this directory) since mounting the whole
// container is impractical for a single wiring check.
describe("command-bar focus hotkeys wired in CanvasPage's useCanvasHotkeys call", () => {
  const source = readFileSync(resolve(process.cwd(), "src/modules/codecanvas/containers/CanvasPage.tsx"), "utf8");
  const hotkeysCallMatch = source.match(/useCanvasHotkeys\(\{[\s\S]*?\n {2}\}\);/);

  it("the useCanvasHotkeys({...}) call exists", () => {
    expect(hotkeysCallMatch).not.toBeNull();
  });

  it("focus-command-bar calls commandBarFocusRegistry.focus()", () => {
    expect(hotkeysCallMatch?.[0] ?? "").toMatch(/"focus-command-bar":\s*\(\)\s*=>\s*commandBarFocusRegistry\.focus\(\)/);
  });

  it("wires no space-bound alternate — Space is ReactFlow's hold-to-pan key", () => {
    // The removed `focus-command-bar-alt` handler was the second half of the panning regression: with
    // it wired, pressing Space moved focus into the NL input, and ReactFlow's useKeyPress then bails
    // out via isInputDOMNode so Space no longer armed panOnDrag. The registry side is guarded by
    // "reserved keys the canvas must not claim" in canvas-hotkeys.test.ts; this is the wiring side.
    expect(hotkeysCallMatch?.[0] ?? "").not.toContain("focus-command-bar-alt");
  });

  it("imports commandBarFocusRegistry from the focus-bridge service", () => {
    expect(source).toMatch(/import \{ commandBarFocusRegistry \} from "\.\.\/services\/command-bar-focus-registry";/);
  });
});

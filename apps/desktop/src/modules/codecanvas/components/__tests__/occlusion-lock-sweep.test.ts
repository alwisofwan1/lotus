import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guardrail: any component that renders a canvas-covering overlay (a modal/dialog, or a portal that
 * escapes to document.body) MUST either hold an occlusion lock — so Canvas Browser Nodes park their
 * native WebView beneath it — or carry an explicit `occlusion-exempt:` marker explaining why not.
 *
 * Native child WebViews paint above the whole DOM, so a new overlay that forgets this reintroduces
 * the "browser page covers the modal" bug. A source scan (not a hand-maintained list) fails on the
 * very PR that adds an unwired overlay.
 */
const COMPONENTS_DIR = join(process.cwd(), "src/modules/codecanvas/components");

const OVERLAY_SIGNALS = [
  /role=["']dialog["']/,
  /aria-modal/,
  /createPortal\s*\(/,
  // Floating menus/listboxes (project switcher, slash menu) paint over the canvas
  // too — a native browser WebView clips them just like a modal.
  /role=["']menu["']/,
  /role=["']listbox["']/,
];
const SATISFIED = [
  /useCanvasOcclusionLock/,
  /useDockedOccluder/,
  /acquireCanvasOcclusion/,
  /occlusion-exempt:/,
];

function collectTsx(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      collectTsx(full, out);
    } else if (entry.endsWith(".tsx") && !entry.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

describe("occlusion lock sweep", () => {
  it("every canvas-covering overlay component takes a lock or is explicitly exempt", () => {
    const offenders: string[] = [];
    let overlaysScanned = 0;
    for (const file of collectTsx(COMPONENTS_DIR)) {
      const src = readFileSync(file, "utf8");
      const isOverlay = OVERLAY_SIGNALS.some((re) => re.test(src));
      if (!isOverlay) continue;
      overlaysScanned += 1;
      const satisfied = SATISFIED.some((re) => re.test(src));
      if (!satisfied) offenders.push(file.replace(COMPONENTS_DIR, "components"));
    }
    // Guard against a broken glob silently passing with zero files scanned.
    expect(overlaysScanned).toBeGreaterThan(4);
    expect(offenders, `overlay components missing useCanvasOcclusionLock or an occlusion-exempt marker:\n${offenders.join("\n")}`).toEqual([]);
  });
});

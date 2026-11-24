import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "src/modules/codecanvas");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "__tests__" || name === "node_modules") continue;
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

describe("Active Frame wiring (LOT2-135, decisions 36-39)", () => {
  const page = read("containers/CanvasPage.tsx");
  const nodes = read("hooks/useCanvasNodes.ts");

  describe("closing / opening a member never zooms out (decision 39)", () => {
    it("the debounced tidy asks decideMutationTidy and only refreshes focus or arranges when it says so", () => {
      expect(page).toMatch(/decideMutationTidy\(\{/);
      expect(page).toMatch(/action === "refresh-focus"/);
      expect(page).toMatch(/action === "arrange-all"/);
    });
    it("no longer falls back to handleArrange for every non-focus-mode mutation", () => {
      expect(page).not.toMatch(/focusedNodeIdRef\.current \? refreshFocus\(\) : handleArrange\(\)/);
    });
    it("focusFrame lives in useCanvasFrameFocus, the one function every fly path uses", () => {
      expect(page).toMatch(/useCanvasFrameFocus\(\{/);
      expect(page).not.toMatch(/const focusFrame = useCallback/);
      expect(page).toMatch(/focusFrame,\s*\n?\s*\}\);/); // handed to the Overview
    });
    it("the node layer announces a member close and add to the re-tile store", () => {
      // Closing may live in its own hook beside useCanvasNodes; either file counts as the node layer.
      const closeHook = join(root, "hooks/useCanvasNodeClose.ts");
      const nodeLayer = nodes + (existsSync(closeHook) ? readFileSync(closeHook, "utf8") : "");
      expect(nodeLayer).toMatch(/(\w+) = (?:node \? )?frameIdOf\(node\)(?: : undefined)?;\s*\n\s*if \(\1\) canvasFrameRetileStore\.request\(\1(?:, \{[^}]*\})?\)/);
      expect(nodes).toMatch(/canvasFrameRetileStore\.request\(frameId, \{ kind: "open"/);
    });
    it("re-tiling does not go through the announcing paths (no feedback loop)", () => {
      const hook = read("hooks/useCanvasFrameFocus.ts");
      expect(hook).not.toMatch(/canvasFrameRetileStore\.request/);
      expect(hook).not.toMatch(/arrangeNodes|handleArrange/);
    });
  });

  describe("every create path decides its Frame through ONE function (decision 38)", () => {
    it("the viewport-centre rule is gone", () => {
      for (const file of sourceFiles(root)) {
        const src = readFileSync(file, "utf8");
        expect(src, file).not.toMatch(/placeInFrameAt/);
      }
      expect(nodes).not.toMatch(/spawnCentreRef/);
    });
    it("useCanvasNodes places new nodes only through placeNew -> placeNewWindowNode", () => {
      expect(nodes).toMatch(/placeNewWindowNode\(nds, node, \{ \.\.\.hints, activeFrameId: canvasActiveFrameStore\.get\(canvasKey\) \}\)/);
      expect(nodes).not.toMatch(/placeInTargetFrame/);
    });
    it("appendNode (tool rail, NL create, notes, tasks, adopt/host cells, standalone browser…) uses it", () => {
      expect(nodes).toMatch(/const appendNode = useCallback\([\s\S]*?placeNew\(nds, staggered, hints\)/);
    });
    it("child nodes join their parent's Frame, dispatched teams are placed one by one", () => {
      expect(nodes).toMatch(/placeNew\(nds, staggered, \{ explicitFrameId: parent \? frameIdOf\(parent\) : undefined \}\)/);
      expect(nodes).toMatch(/staggered\.reduce<Node\[\]>\(\(acc, n\) => placeNew\(acc, n\), nds\)/);
    });
    it("agents (MCP lotus_spawn_cell, NL, Frame '+') pass the explicit Frame and the task flag", () => {
      expect(nodes).toMatch(/placeNew\(nds, node, \{ explicitFrameId: options\?\.frameId, hasTask: Boolean\(options\?\.spawnTask\) \}\)/);
    });
    it("terminals pass the explicit Frame (Frame '+') through appendNode", () => {
      expect(nodes).toMatch(/appendNode\(created, \{ explicitFrameId: frameId \}\)/);
    });
    it("no create path appends a window node to the array on its own", () => {
      // The only raw appends left are the shape batch and the snapshot load.
      expect(nodes).not.toMatch(/\[\.\.\.nds, (node|staggered|placed|created)\]/);
    });
    it("the MCP spawn bridge reaches addAgentNode through the create-agent command, never placing nodes itself", () => {
      const bridge = read("hooks/useMcpCanvasSpawnBridge.ts");
      expect(bridge).not.toMatch(/setNodes|placeInTargetFrame|placeNewWindowNode/);
      expect(page).toMatch(/kind: "create-agent",\s*\n\s*definition: def,/);
    });
  });

  describe("always a Frame (decision 37)", () => {
    it("opening a canvas wraps loose windows through wrapLooseWindowsInFrame", () => {
      expect(nodes).toMatch(/setNodes\(wrapLooseWindowsInFrame\(numberedNodes\.map/);
    });
  });

  describe("active Frame state (decision 36)", () => {
    it("the chip row shows the active Frame", () => {
      expect(page).toMatch(/activeFrameId/);
      expect(read("components/CanvasFrameSwitcher.tsx")).toMatch(/aria-current=\{chip\.frameId === activeFrameId \? "true" : undefined\}/);
    });
    it("the Frame store is a per-canvas store with guarded storage, not CanvasPage state", () => {
      const store = read("services/canvas-active-frame.ts");
      expect(store).toMatch(/localStorage/);
      expect(store).toMatch(/try \{/);
      expect(page).not.toMatch(/useState<string \| null>\(null\);\s*\n.*activeFrame/);
    });
    it("title-tab actions make their Frame active", () => {
      expect(read("hooks/useCanvasFrameUi.ts")).toMatch(/activateFrame\(frameId\)/);
    });
  });
});

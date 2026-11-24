import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, "m"));
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

describe("canvas CSS — shared node resize affordance", () => {
  const edgesCss = readFileSync(resolve(process.cwd(), "src/styles/canvas/edges.css"), "utf8");
  const nodeShellCss = readFileSync(resolve(process.cwd(), "src/styles/canvas/node-shell.css"), "utf8");
  const resizeCss = readFileSync(resolve(process.cwd(), "src/styles/canvas/node-resize.css"), "utf8");
  const skillsCss = readFileSync(resolve(process.cwd(), "src/styles/canvas/skills-node.css"), "utf8");
  const musicCss = readFileSync(resolve(process.cwd(), "src/styles/canvas/music-node.css"), "utf8");
  const css = `${edgesCss}\n${nodeShellCss}\n${resizeCss}\n${skillsCss}\n${musicCss}`;

  it("makes the shared node shell fill the ReactFlow wrapper", () => {
    const rule = cssRule(css, ".canvas-node");
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/height:\s*100%/);
    expect(rule).toMatch(/min-width:\s*0/);
    expect(rule).toMatch(/min-height:\s*0/);
  });

  it("does not pin note nodes to a fixed pixel width", () => {
    const rule = cssRule(css, ".canvas-note-node");
    expect(rule).not.toMatch(/width:\s*\d+px/);
    expect(rule).not.toMatch(/height:\s*\d+px/);
  });

  it("gives resize handles a larger hit target than React Flow defaults", () => {
    const rule = cssRule(css, ".canvas-node .canvas-node-resize-handle");
    expect(rule).toMatch(/width:\s*18px/);
    expect(rule).toMatch(/height:\s*18px/);
  });

  it("styles shape resize chrome separately so ReactFlow lines do not masquerade as the shape stroke", () => {
    const controlRule = cssRule(css, ".canvas-shape-node .react-flow__resize-control");
    expect(controlRule).toMatch(/z-index:\s*8/);

    const lineRule = cssRule(css, ".canvas-shape-node .canvas-node-resize-line");
    expect(lineRule).toMatch(/border-color:\s*rgba\(232, 102, 61, 0\.34\)/);
  });

  it("keeps browser resize controls reachable over the native WebView", () => {
    const controlRule = cssRule(css, ".canvas-browser-node .react-flow__resize-control");
    // Hidden until hover or selection like every node (07k), but never unreachable.
    expect(controlRule).not.toMatch(/opacity/);
    expect(controlRule).toMatch(/pointer-events:\s*all/);

    const handleRule = cssRule(css, ".canvas-browser-node .canvas-node-resize-handle");
    expect(handleRule).toMatch(/width:\s*22px/);
    expect(handleRule).toMatch(/height:\s*22px/);
  });

  it("allows plan and skill nodes to fill their resized wrapper", () => {
    const match = css.match(/\.canvas-skill-node,\s*\n\.canvas-skills-node,\s*\n\.canvas-plan-node\s*\{[\s\S]*?^\}/m);
    expect(match).not.toBeNull();
    const rule = match?.[0] ?? "";
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).toMatch(/height:\s*100%/);
  });

  it("positions wire handles outside the node border", () => {
    expect(cssRule(css, ".codecanvas-shell .canvas-node-handle--left")).toMatch(/transform:\s*translate\(calc\(-100% - 6px\), -50%\)/);
    expect(cssRule(css, ".codecanvas-shell .canvas-node-handle--right")).toMatch(/transform:\s*translate\(calc\(100% \+ 6px\), -50%\)/);
    expect(cssRule(css, ".codecanvas-shell .canvas-node-handle--top")).toMatch(/transform:\s*translate\(-50%, calc\(-100% - 6px\)\)/);
    expect(cssRule(css, ".codecanvas-shell .canvas-node-handle--bottom")).toMatch(/transform:\s*translate\(-50%, calc\(100% \+ 6px\)\)/);
  });

  it("makes the music player adapt to node size instead of viewport size", () => {
    const rule = cssRule(css, ".canvas-music");
    expect(rule).toMatch(/container-name:\s*music-node/);
    expect(rule).toMatch(/container-type:\s*size/);
    expect(musicCss).toContain("@container music-node (max-width: 360px) and (max-aspect-ratio: 1.11)");
    expect(musicCss).toContain("@container music-node (min-width: 320px) and (min-aspect-ratio: 1.12)");
    expect(musicCss).toContain("@container music-node (max-height: 330px) and (max-aspect-ratio: 1.11)");
  });

  it("keeps the video host's landing rect clear of the seek rail", () => {
    // The host is a body-level fixed element parked over this box, so anything it
    // covers stops being clickable. The bottom inset is what keeps seeking working.
    const rule = cssRule(css, ".canvas-music-media-slot");
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/inset:\s*0 0 10px 0/);
    expect(cssRule(css, ".canvas-music-seek")).toMatch(/bottom:\s*0/);
  });

  it("keeps the music node gel layer bounded with an accessibility fallback", () => {
    expect(cssRule(css, ".canvas-music::before")).toMatch(/backdrop-filter:\s*blur\(7px\) saturate\(1\.08\) brightness\(0\.96\)/);
    expect(musicCss).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*?\.canvas-music::before[\s\S]*?backdrop-filter:\s*none;/);
  });
});

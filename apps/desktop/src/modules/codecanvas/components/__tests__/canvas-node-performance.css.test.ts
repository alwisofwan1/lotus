import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`^${escaped}\\s*\\{[\\s\\S]*?^\\}`, "m"));
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

describe("canvas node CSS performance policy", () => {
  const themeCss = readFileSync(resolve(process.cwd(), "src/styles/canvas/theme.css"), "utf8");
  const nodeCss = readFileSync(resolve(process.cwd(), "src/styles/canvas/node-shell.css"), "utf8");
  const motionCss = readFileSync(resolve(process.cwd(), "src/styles/canvas/motion.css"), "utf8");

  it("keeps resting nodes off the expensive backdrop-filter path", () => {
    expect(themeCss).toMatch(/--node-resting-filter:\s*none;/);
    expect(cssRule(nodeCss, ".canvas-node")).toMatch(/backdrop-filter:\s*var\(--node-resting-filter, none\);/);
  });

  it("enables node glass only for selected, focused, or custom-background moments", () => {
    expect(nodeCss).toMatch(/\.canvas-node\.selected,[\s\S]*?\.canvas-node:focus-within\s*\{[\s\S]*?backdrop-filter:\s*var\(--node-glass-filter\);/);
    expect(cssRule(nodeCss, ".codecanvas-shell[data-canvas-theme=\"custom\"] .canvas-node")).toMatch(/backdrop-filter:\s*var\(--node-glass-filter\);/);
  });

  it("uses ReactFlow wrapper transform transitions for arrange and other programmatic moves", () => {
    expect(cssRule(motionCss, ".codecanvas-shell[data-canvas-motion=\"on\"] .react-flow__node:not(.dragging):not(.canvas-node-leaving)")).toMatch(/transition:\s*transform var\(--canvas-motion-move/);
    expect(cssRule(motionCss, ".codecanvas-shell[data-canvas-arranging] .react-flow__node:not(.canvas-node-leaving)")).toMatch(/transition-duration:\s*var\(--canvas-motion-arrange/);
  });

  it("keeps collapsed glyphs still while camera motion is active", () => {
    expect(cssRule(motionCss, ".codecanvas-shell[data-canvas-viewport-motion=\"active\"] .canvas-node-glyph")).toMatch(/animation-name:\s*none/);
  });

  it("collapses node and edge motion while a project switch is hydrating", () => {
    expect(cssRule(motionCss, ".codecanvas-shell[data-canvas-project-transition=\"fast\"] .react-flow__node,\n.codecanvas-shell[data-canvas-project-transition=\"fast\"] .canvas-node,\n.codecanvas-shell[data-canvas-project-transition=\"fast\"] .react-flow__edge")).toMatch(/transition-duration:\s*0\.01ms/);
    expect(cssRule(motionCss, ".codecanvas-shell[data-canvas-project-transition=\"fast\"] .canvas-node")).toMatch(/backdrop-filter:\s*none !important/);
  });

  it("uses a small open/close anticipation delay and genie-scale node keyframes", () => {
    expect(cssRule(nodeCss, ".canvas-node")).toMatch(/transform-origin:\s*50% 50%/);
    expect(cssRule(nodeCss, ".canvas-node")).toMatch(/animation-delay:\s*calc\(var\(--canvas-motion-enter-delay, 0ms\) \+ var\(--canvas-enter-delay, 0ms\)\)/);
    expect(cssRule(nodeCss, ".react-flow__node.canvas-node-leaving .canvas-node")).toMatch(/animation-delay:\s*calc\(var\(--canvas-motion-leave-delay, 0ms\) \+ var\(--canvas-leave-delay, 0ms\)\)/);
    expect(nodeCss).toMatch(/@keyframes canvas-node-enter[\s\S]*scaleX\(0\.82\) scaleY\(0\.58\)[\s\S]*scaleX\(0\.97\) scaleY\(0\.92\)/);
    expect(nodeCss).toMatch(/@keyframes canvas-node-leave[\s\S]*scale\(0\.992\)[\s\S]*scale\(0\.94\)/);
    const leaveBlock = nodeCss.split("@keyframes canvas-node-leave")[1]?.split("/* The close dispatcher")[0] ?? "";
    expect(leaveBlock).not.toContain("border-radius");
  });

  it("keeps close motion lightweight for heavy runtime nodes", () => {
    expect(cssRule(nodeCss, ".react-flow__node.canvas-node-leaving")).toMatch(/contain:\s*layout paint style/);
    expect(cssRule(nodeCss, ".react-flow__node.canvas-node-leaving .canvas-node")).toMatch(/animation:\s*canvas-node-leave var\(--canvas-motion-leave/);
    expect(cssRule(nodeCss, ".react-flow__node.canvas-node-leaving .canvas-node::before,\n.react-flow__node.canvas-node-leaving .canvas-node::after")).toMatch(/transition-duration:\s*0\.01ms/);
  });

  it("keeps selection feedback off the mount transform path", () => {
    expect(cssRule(nodeCss, ".canvas-node.selected:where(:not(.canvas-agent-node)):where(:not(.canvas-terminal-node)):where(:not(.canvas-node--glyph))::before")).toMatch(/canvas-select-aura/);
    expect(cssRule(nodeCss, ".react-flow__node.canvas-node-restored:not(.canvas-node-leaving) .canvas-node")).toMatch(/animation:\s*none/);
    expect(nodeCss).not.toMatch(/\.canvas-node\.selected:where\(:not\(\.canvas-agent-node\)\):where\(:not\(\.canvas-node--glyph\)\)\s*\{[\s\S]*?canvas-node-enter/);
  });

  it("provides a reduced-transparency escape hatch", () => {
    expect(nodeCss).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*?backdrop-filter:\s*none;/);
  });
});

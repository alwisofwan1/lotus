import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { CanvasNodeFrame } from "../CanvasNodeFrame";

function renderFrame(props: Partial<React.ComponentProps<typeof CanvasNodeFrame>> = {}) {
  const { container } = render(
    <ReactFlowProvider>
      <CanvasNodeFrame kind="agent" selected={false} minWidth={200} minHeight={140} header={<div>hdr</div>} {...props}>
        <div>body</div>
      </CanvasNodeFrame>
    </ReactFlowProvider>,
  );
  return container;
}

describe("CanvasNodeFrame drop target", () => {
  it("adds the drop-target class and a drop label only while armed", () => {
    const armed = renderFrame({ dropActive: true, dropLabel: "Drop to attach to Ren" });
    const node = armed.querySelector(".canvas-node")!;
    expect(node.classList.contains("canvas-node--drop-target")).toBe(true);
    expect(armed.querySelector(".canvas-node-drop-pill")?.textContent).toContain("Ren");
  });

  it("shows no drop frame when not armed", () => {
    const idle = renderFrame({ dropActive: false });
    expect(idle.querySelector(".canvas-node")!.classList.contains("canvas-node--drop-target")).toBe(false);
    expect(idle.querySelector(".canvas-node-drop-pill")).toBeNull();
  });
});

describe("CanvasNodeFrame spawn sheen", () => {
  it("renders the sheen layer for the two live glass families", () => {
    for (const kind of ["terminal", "agent"] as const) {
      expect(renderFrame({ kind }).querySelector(".canvas-node-sheen"), kind).not.toBeNull();
    }
  });

  it("leaves every other node kind without one — the sheen is the live-glass idiom, not chrome", () => {
    for (const kind of ["note", "task", "plan", "browser", "music"] as const) {
      expect(renderFrame({ kind }).querySelector(".canvas-node-sheen"), kind).toBeNull();
    }
  });

  it("keeps the sheen mounted at collapsed LOD so a zoom-out/in never replays the sweep", () => {
    // The element sits OUTSIDE the collapsed/full body swap on purpose: it mounts once with the
    // node and its one-shot CSS animation is spent from then on. Remounting it on every LOD
    // crossing would flash a "just spawned" highlight across nodes that have been running for
    // minutes.
    const collapsed = renderFrame({ kind: "terminal", lodTier: "glyph", glyph: <div>glyph</div> });
    expect(collapsed.querySelector(".canvas-node-sheen")).not.toBeNull();
  });

  it("is inert — it must never intercept a click meant for the xterm underneath", () => {
    const sheen = renderFrame({ kind: "terminal" }).querySelector(".canvas-node-sheen")!;
    expect(sheen.getAttribute("aria-hidden")).toBe("true");
  });
});

import { describe, expect, it, vi } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { ShapeNode, buildShapeRoughPaths, textTypographyStyle, SHAPE_REGEN_IDLE_MS } from "../ShapeNode";
import type { CanvasShapeNodeData } from "../../../types/canvas";

const readNoteAsset = vi.fn(async (id: string) => ({
  asset: { id, mime: "image/png", originalName: "shot.png", fileName: `${id}.png` },
  base64: "AAAA",
}));
vi.mock("@/lib/tauri/codecanvas", () => ({
  codecanvasReadNoteAsset: (id: string) => readNoteAsset(id),
}));

function renderShape(overrides: Partial<CanvasShapeNodeData> = {}, selected = false) {
  const dispatchCommand = vi.fn();
  const data: CanvasShapeNodeData = { shape: "rectangle", dispatchCommand, ...overrides };
  const { container } = render(
    <ReactFlowProvider>
      <ShapeNode id="shape-1" data={data as unknown as Record<string, unknown>} selected={selected} type="shape"
        width={200} height={140} dragging={false} zIndex={0} isConnectable positionAbsoluteX={0} positionAbsoluteY={0} deletable selectable draggable />
    </ReactFlowProvider>,
  );
  return { container, dispatchCommand };
}

describe("buildShapeRoughPaths", () => {
  it("produces rough paths for rectangle, ellipse and diamond", () => {
    for (const shape of ["rectangle", "ellipse", "diamond"] as const) {
      const paths = buildShapeRoughPaths(shape, 200, 140, 7);
      expect(paths.length).toBeGreaterThan(0);
      expect(paths[0].d).toBeTruthy();
    }
  });

  it("returns no paths for the text shape (label only, no outline)", () => {
    expect(buildShapeRoughPaths("text", 200, 140, 7)).toEqual([]);
  });

  it("draws a line, and an arrow adds an arrowhead (more strokes than a plain line)", () => {
    const line = buildShapeRoughPaths("line", 100, 60, 5, undefined, [[0, 0], [1, 1]]);
    const arrow = buildShapeRoughPaths("arrow", 100, 60, 5, undefined, [[0, 0], [1, 1]]);
    expect(line.length).toBeGreaterThan(0);
    expect(arrow.length).toBeGreaterThan(line.length);
  });

  it("returns no paths before the node is measured", () => {
    expect(buildShapeRoughPaths("rectangle", 0, 0, 7)).toEqual([]);
  });

  it("honors the configured end arrowhead and 'none'", () => {
    const withHead = buildShapeRoughPaths("arrow", 100, 60, 5, { endArrowhead: "arrow", startArrowhead: "none" }, [[0, 0], [1, 1]]);
    const noHead = buildShapeRoughPaths("arrow", 100, 60, 5, { endArrowhead: "none", startArrowhead: "none" }, [[0, 0], [1, 1]]);
    expect(withHead.length).toBeGreaterThan(noHead.length);
  });

  it("adds a second arrowhead when the start head is also set", () => {
    const endOnly = buildShapeRoughPaths("arrow", 100, 60, 5, { startArrowhead: "none", endArrowhead: "arrow" }, [[0, 0], [1, 1]]);
    const both = buildShapeRoughPaths("arrow", 100, 60, 5, { startArrowhead: "arrow", endArrowhead: "arrow" }, [[0, 0], [1, 1]]);
    expect(both.length).toBeGreaterThan(endOnly.length);
  });

  it("routes an elbow arrow through at least as many segments as a straight one", () => {
    const straight = buildShapeRoughPaths("arrow", 100, 60, 5, { arrowType: "straight", endArrowhead: "none" }, [[0, 0], [1, 1]]);
    const elbow = buildShapeRoughPaths("arrow", 100, 60, 5, { arrowType: "elbow", endArrowhead: "none" }, [[0, 0], [1, 1]]);
    expect(straight.length).toBeGreaterThan(0);
    expect(elbow.length).toBeGreaterThanOrEqual(straight.length);
  });

  it("renders a curved line through three points", () => {
    const paths = buildShapeRoughPaths("line", 120, 80, 5, { arrowType: "curved" }, [[0, 0], [0.5, 1], [1, 0]]);
    expect(paths.length).toBeGreaterThan(0);
  });

  it("is deterministic for the same shape/size/seed", () => {
    const a = buildShapeRoughPaths("ellipse", 200, 140, 9);
    const b = buildShapeRoughPaths("ellipse", 200, 140, 9);
    expect(b[0].d).toBe(a[0].d);
  });
});

describe("ShapeNode image", () => {
  it("renders a bitmap that resolves the note-asset URI to a data URL, with alt text", async () => {
    const { container } = renderShape({ shape: "image", imageAssetUri: "lotus-note-asset://asset_abc", imageAlt: "a screenshot" });
    await waitFor(() => expect(readNoteAsset).toHaveBeenCalledWith("asset_abc"));
    const img = await waitFor(() => {
      const el = container.querySelector("img.canvas-shape-image") as HTMLImageElement | null;
      if (!el) throw new Error("img not yet rendered");
      return el;
    });
    expect(img.alt).toBe("a screenshot");
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("never renders an <img> with an empty src — shows a loading placeholder until the asset resolves", () => {
    readNoteAsset.mockImplementationOnce(() => new Promise(() => {})); // pending forever
    const { container } = renderShape({ shape: "image", imageAssetUri: "lotus-note-asset://pending" });
    expect(container.querySelector("img.canvas-shape-image")).toBeNull();
    expect(container.querySelector(".canvas-shape-image-loading")).not.toBeNull();
  });

  it("draws no rough SVG or text label for an image shape (it's a bitmap)", () => {
    const { container } = renderShape({ shape: "image", imageAssetUri: "lotus-note-asset://asset_abc" });
    expect(container.querySelector(".canvas-shape-svg")).toBeNull();
    expect(container.querySelector(".canvas-shape-label")).toBeNull();
  });
});

describe("ShapeNode labels", () => {
  it("renders a container's centered text content inside the shape (Excalidraw-style binding)", () => {
    const { container } = renderShape({ shape: "rectangle", text: "checkout flow" });
    const centered = container.querySelector(".canvas-shape-label");
    expect(centered?.textContent).toBe("checkout flow");
  });

  it("renders the optional area label as a top-left corner tag, alongside any centered text", () => {
    const { container } = renderShape({ shape: "rectangle", text: "body", areaLabel: "checkout flow" });
    expect(container.querySelector(".canvas-shape-arealabel")?.textContent).toBe("checkout flow");
    expect(container.querySelector(".canvas-shape-label")?.textContent).toBe("body");
  });

  it("shows no centered label and no corner tag for an empty container", () => {
    const { container } = renderShape({ shape: "rectangle" });
    expect(container.querySelector(".canvas-shape-label")).toBeNull();
    expect(container.querySelector(".canvas-shape-arealabel")).toBeNull();
  });

  it("renders a text shape's content centered", () => {
    const { container } = renderShape({ shape: "text", text: "Ship it" });
    expect(container.querySelector(".canvas-shape-label")?.textContent).toBe("Ship it");
    expect(container.querySelector(".canvas-shape-arealabel")).toBeNull();
  });

  it("double-click on a container opens the centered text editor (not a corner editor)", () => {
    const { container } = renderShape({ shape: "rectangle", text: "hi", areaLabel: "flow" });
    fireEvent.doubleClick(container.querySelector(".canvas-shape-node")!);
    const editor = container.querySelector("textarea.canvas-shape-edit") as HTMLTextAreaElement;
    expect(editor).not.toBeNull();
    expect(editor.value).toBe("hi"); // edits the centered text, not the area label
    expect(container.querySelector("textarea.canvas-shape-arealabel-edit")).toBeNull();
  });

  it("removes an emptied text shape on commit (no orphan empty boxes)", () => {
    const { container, dispatchCommand } = renderShape({ shape: "text", text: "hi" }, true);
    fireEvent.doubleClick(container.querySelector(".canvas-shape-node")!);
    const ta = container.querySelector("textarea.canvas-shape-edit")!;
    fireEvent.change(ta, { target: { value: "   " } }); // whitespace only
    fireEvent.blur(ta);
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "close-node", nodeId: "shape-1" });
  });

  it("commits non-empty text as a patch, not a removal", () => {
    const { container, dispatchCommand } = renderShape({ shape: "text", text: "hi" }, true);
    fireEvent.doubleClick(container.querySelector(".canvas-shape-node")!);
    const ta = container.querySelector("textarea.canvas-shape-edit")!;
    fireEvent.change(ta, { target: { value: "hello" } });
    fireEvent.blur(ta);
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-shape", nodeId: "shape-1", patch: { text: "hello" } });
  });

  it("does NOT remove a container when its centered text is emptied", () => {
    const { container, dispatchCommand } = renderShape({ shape: "rectangle", text: "hi" }, true);
    fireEvent.doubleClick(container.querySelector(".canvas-shape-node")!);
    const ta = container.querySelector("textarea.canvas-shape-edit")!;
    fireEvent.change(ta, { target: { value: "" } });
    fireEvent.blur(ta);
    expect(dispatchCommand).not.toHaveBeenCalledWith({ kind: "close-node", nodeId: "shape-1" });
  });

  it("double-click on a text shape opens the full-box text editor", () => {
    const { container } = renderShape({ shape: "text", text: "hi" });
    expect(container.querySelector(".canvas-shape-node")).not.toBeNull();
    fireEvent.doubleClick(container.querySelector(".canvas-shape-node")!);
    expect(container.querySelector("textarea.canvas-shape-edit")).not.toBeNull();
  });

  it("applies the font family and alignment to the rendered text content", () => {
    const { container } = renderShape({ shape: "text", text: "hi", style: { fontFamily: "heading", textAlign: "right" } });
    const el = container.querySelector(".canvas-shape-label") as HTMLElement;
    expect(el.style.fontFamily).toContain("--canvas-heading");
    expect(el.style.textAlign).toBe("right");
  });

  it("keeps fit-to-box (cqh) font size for container text (fills the shape)", () => {
    expect(textTypographyStyle({ fontSize: "L" }, "fit").fontSize).toContain("cqh"); // scales with box height
    const ratio = (tier: "S" | "XL") => Number(textTypographyStyle({ fontSize: tier }, "fit").fontSize.match(/([\d.]+)cqh/)![1]);
    expect(ratio("XL")).toBeGreaterThan(ratio("S"));
  });

  it("uses an absolute px font size for standalone text (predictable, box-independent)", () => {
    expect(textTypographyStyle({ fontSize: "XL" }, "absolute").fontSize).toBe("36px");
    expect(textTypographyStyle({ fontSize: "S" }, "absolute").fontSize).toBe("16px");
    expect(textTypographyStyle({ fontSize: "M" }, "absolute").fontSize).toBe("20px");
  });

  it("scales the absolute font by fontScale (corner-resize), defaulting to 1×", () => {
    expect(textTypographyStyle({ fontSize: "M", fontScale: 2 }, "absolute").fontSize).toBe("40px");
    expect(textTypographyStyle({ fontSize: "M", fontScale: 1.5 }, "absolute").fontSize).toBe("30px");
    expect(textTypographyStyle({ fontSize: "M" }, "absolute").fontSize).toBe("20px");
  });

  it("colors the text with the stroke color (text's 'stroke' is its ink), defaulting to light ink", () => {
    expect(textTypographyStyle({ strokeColor: "#4aa8a0" }).color).toBe("#4aa8a0");
    expect(textTypographyStyle(undefined).color).toBe("#f1f3f5"); // default = first stroke swatch
  });

  it("maps vertical align to the label's flex justification, defaulting to center", () => {
    expect(textTypographyStyle({ verticalAlign: "top" }).justifyContent).toBe("flex-start");
    expect(textTypographyStyle({ verticalAlign: "bottom" }).justifyContent).toBe("flex-end");
    expect(textTypographyStyle(undefined).justifyContent).toBe("center");
  });

  it("renders the text content in the chosen stroke color", () => {
    const { container } = renderShape({ shape: "text", text: "hi", style: { strokeColor: "#4aa8a0" } });
    const el = container.querySelector(".canvas-shape-label") as HTMLElement;
    expect(el.style.color).toBe("rgb(74, 168, 160)"); // #4aa8a0
  });
});

describe("ShapeNode stroke style (dash)", () => {
  const dashOf = (container: HTMLElement) =>
    [...container.querySelectorAll(".canvas-shape-svg path")].map((p) => p.getAttribute("stroke-dasharray") || "");

  it("renders a dashed diamond outline as an actual dashed stroke", () => {
    const { container } = renderShape({ shape: "diamond", style: { strokeStyle: "dashed" } });
    expect(dashOf(container).some((d) => d.trim().length > 0)).toBe(true);
  });

  it("renders a solid diamond with no dash array", () => {
    const { container } = renderShape({ shape: "diamond", style: { strokeStyle: "solid" } });
    expect(dashOf(container).every((d) => d.trim().length === 0)).toBe(true);
  });

  it("renders the bold tier as a zoom-stable stroke so it stays visible on the canvas", () => {
    const { container } = renderShape({ shape: "rectangle", style: { strokeWidth: 8 } });
    const paths = [...container.querySelectorAll(".canvas-shape-svg path")];
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((p) => p.getAttribute("vector-effect") === "non-scaling-stroke")).toBe(true);
    expect(paths.some((p) => Number(p.getAttribute("stroke-width")) >= 8)).toBe(true);
  });

  it("dashes only the outline, never the hachure fill lines", () => {
    const { container } = renderShape({ shape: "diamond", style: { strokeStyle: "dotted", fill: "#1f3320", fillStyle: "hachure" } });
    const paths = [...container.querySelectorAll(".canvas-shape-svg path")];
    const dashed = paths.filter((p) => (p.getAttribute("stroke-dasharray") || "").trim().length > 0);
    // exactly the single outline stroke carries a dash, not the (multiple) fill stroke paths
    expect(dashed.length).toBe(1);
  });
});

describe("ShapeNode edit hint", () => {
  it("shows no hint while a shape is merely selected (kept clean; Enter still starts editing)", () => {
    renderShape({ shape: "rectangle" }, true);
    expect(document.body.querySelector(".canvas-edit-hint")).toBeNull();
  });

  it("shows the 'finish editing' hint only while editing text", () => {
    const { container } = renderShape({ shape: "rectangle", text: "hi" }, true);
    fireEvent.doubleClick(container.querySelector(".canvas-shape-node")!);
    expect(document.body.querySelector(".canvas-edit-hint")?.textContent).toMatch(/finish editing/i);
  });

  it("shows no hint when the shape is not selected", () => {
    renderShape({ shape: "rectangle" }, false);
    expect(document.body.querySelector(".canvas-edit-hint")).toBeNull();
  });
});

describe("ShapeNode point editing", () => {
  it("shows a draggable handle per point when a linear shape is selected", () => {
    const { container } = renderShape({ shape: "arrow", points: [[0, 0], [0.5, 0.5], [1, 1]] }, true);
    expect(container.querySelectorAll(".canvas-point-handle")).toHaveLength(3);
  });

  it("hides the point handles when the shape is not selected", () => {
    const { container } = renderShape({ shape: "arrow", points: [[0, 0], [1, 1]] }, false);
    expect(container.querySelectorAll(".canvas-point-handle")).toHaveLength(0);
  });

  it("does not show point handles for container shapes", () => {
    const { container } = renderShape({ shape: "rectangle" }, true);
    expect(container.querySelectorAll(".canvas-point-handle")).toHaveLength(0);
  });
});

describe("ShapeNode edit request (text tool over an existing shape)", () => {
  const nodeProps = (data: CanvasShapeNodeData) => ({
    id: "shape-1",
    data: data as unknown as Record<string, unknown>,
    selected: false,
    type: "shape",
    width: 200,
    height: 140,
    dragging: false,
    zIndex: 0,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    deletable: true,
    selectable: true,
    draggable: true,
  } as const);

  it("opens the text editor when editRequestId changes after mount", () => {
    const dispatchCommand = vi.fn();
    const base: CanvasShapeNodeData = { shape: "rectangle", text: "hello", dispatchCommand };
    const { container, rerender } = render(
      <ReactFlowProvider><ShapeNode {...nodeProps(base)} /></ReactFlowProvider>,
    );
    expect(container.querySelector("textarea.canvas-shape-edit")).toBeNull();
    rerender(
      <ReactFlowProvider><ShapeNode {...nodeProps({ ...base, editRequestId: 7 })} /></ReactFlowProvider>,
    );
    const editor = container.querySelector("textarea.canvas-shape-edit") as HTMLTextAreaElement;
    expect(editor).not.toBeNull();
    expect(editor.value).toBe("hello");
  });

  it("does not open the editor for an editRequestId already present on mount (reload safety)", () => {
    const dispatchCommand = vi.fn();
    const { container } = render(
      <ReactFlowProvider>
        <ShapeNode {...nodeProps({ shape: "rectangle", text: "hello", editRequestId: 7, dispatchCommand })} />
      </ReactFlowProvider>,
    );
    expect(container.querySelector("textarea.canvas-shape-edit")).toBeNull();
  });

  it("ignores edit requests on shapes without editable text (image)", () => {
    const dispatchCommand = vi.fn();
    const base: CanvasShapeNodeData = { shape: "image", imageAssetUri: "lotus-note-asset://a1", dispatchCommand };
    const { container, rerender } = render(
      <ReactFlowProvider><ShapeNode {...nodeProps(base)} /></ReactFlowProvider>,
    );
    rerender(
      <ReactFlowProvider><ShapeNode {...nodeProps({ ...base, editRequestId: 7 })} /></ReactFlowProvider>,
    );
    expect(container.querySelector("textarea.canvas-shape-edit")).toBeNull();
  });
});

describe("ShapeNode Escape semantics (Excalidraw: Escape commits, never discards)", () => {
  it("Escape commits the typed draft instead of silently dropping it", () => {
    const { container, dispatchCommand } = renderShape({ shape: "rectangle", text: "old" });
    fireEvent.doubleClick(container.querySelector(".canvas-shape-node")!);
    const editor = container.querySelector("textarea.canvas-shape-edit") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "new text" } });
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-shape", nodeId: "shape-1", patch: { text: "new text" } });
    expect(container.querySelector("textarea.canvas-shape-edit")).toBeNull();
  });

  it("Escape on a fresh empty text element removes it — no ghost 'Text' node", () => {
    const { container, dispatchCommand } = renderShape({ shape: "text" }); // empty text opens straight into edit
    const editor = container.querySelector("textarea.canvas-shape-edit") as HTMLTextAreaElement;
    expect(editor).not.toBeNull();
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "close-node", nodeId: "shape-1" });
  });
});

describe("ShapeNode resize-time geometry cache", () => {
  const props = (w: number, h: number, data: CanvasShapeNodeData) => ({
    id: "shape-1",
    data: data as unknown as Record<string, unknown>,
    selected: false,
    type: "shape",
    width: w,
    height: h,
    dragging: false,
    zIndex: 0,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    deletable: true,
    selectable: true,
    draggable: true,
  } as const);

  it("stretches the existing rough geometry during a live resize and regenerates once at rest", () => {
    vi.useFakeTimers();
    const data: CanvasShapeNodeData = { shape: "rectangle", dispatchCommand: vi.fn() };
    const { container, rerender } = render(
      <ReactFlowProvider><ShapeNode {...props(200, 140, data)} /></ReactFlowProvider>,
    );
    const svg = () => container.querySelector("svg.canvas-shape-svg")!;
    expect(svg().getAttribute("viewBox")).toBe("0 0 200 140");
    // mid-gesture frames: geometry is NOT regenerated — the old paths stretch to the new box
    rerender(<ReactFlowProvider><ShapeNode {...props(260, 140, data)} /></ReactFlowProvider>);
    expect(svg().getAttribute("viewBox")).toBe("0 0 200 140");
    rerender(<ReactFlowProvider><ShapeNode {...props(320, 180, data)} /></ReactFlowProvider>);
    expect(svg().getAttribute("viewBox")).toBe("0 0 200 140");
    // gesture settles → one regeneration at the final size
    act(() => { vi.advanceTimersByTime(SHAPE_REGEN_IDLE_MS + 10); });
    expect(svg().getAttribute("viewBox")).toBe("0 0 320 180");
    vi.useRealTimers();
  });

  it("adopts the first real measurement immediately (no debounce from the unmeasured state)", () => {
    vi.useFakeTimers();
    const data: CanvasShapeNodeData = { shape: "rectangle", dispatchCommand: vi.fn() };
    const { container, rerender } = render(
      <ReactFlowProvider><ShapeNode {...props(0, 0, data)} /></ReactFlowProvider>,
    );
    expect(container.querySelector("svg.canvas-shape-svg")).toBeNull(); // unmeasured → no paths
    rerender(<ReactFlowProvider><ShapeNode {...props(200, 140, data)} /></ReactFlowProvider>);
    expect(container.querySelector("svg.canvas-shape-svg")!.getAttribute("viewBox")).toBe("0 0 200 140");
    vi.useRealTimers();
  });
});

describe("ShapeNode rotation", () => {
  it("rotates the shape content around its center from data.angle", () => {
    const { container } = renderShape({ shape: "rectangle", angle: 45 });
    const rotor = container.querySelector(".canvas-shape-rotor") as HTMLElement;
    expect(rotor).not.toBeNull();
    expect(rotor.style.transform).toBe("rotate(45deg)");
  });

  it("renders no rotation transform when upright", () => {
    const { container } = renderShape({ shape: "rectangle" });
    const rotor = container.querySelector(".canvas-shape-rotor") as HTMLElement;
    expect(rotor.style.transform).toBe("");
  });

  it("shows the rotate handle only while selected", () => {
    const unselected = renderShape({ shape: "rectangle" });
    expect(unselected.container.querySelector(".canvas-rotate-handle")).toBeNull();
    const selected = renderShape({ shape: "rectangle" }, true);
    expect(selected.container.querySelector(".canvas-rotate-handle")).not.toBeNull();
  });

  it("dragging the rotate handle commits the new angle on release", () => {
    const { container, dispatchCommand } = renderShape({ shape: "rectangle" }, true);
    const handle = container.querySelector(".canvas-rotate-handle")!;
    // jsdom boxes are zero-sized → the shape center is (0,0); pointer at (10,0) = 90° clockwise
    fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: -10 });
    fireEvent.pointerMove(handle, { clientX: 10, clientY: 0 });
    fireEvent.pointerUp(handle, { clientX: 10, clientY: 0 });
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-shape", nodeId: "shape-1", patch: { angle: 90 } });
  });

  it("snaps to 15° steps while Shift is held", () => {
    const { container, dispatchCommand } = renderShape({ shape: "rectangle" }, true);
    const handle = container.querySelector(".canvas-rotate-handle")!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: -10 });
    fireEvent.pointerMove(handle, { clientX: 10, clientY: 1, shiftKey: true }); // ~95.7° raw
    fireEvent.pointerUp(handle, { clientX: 10, clientY: 1, shiftKey: true });
    expect(dispatchCommand).toHaveBeenCalledWith({ kind: "patch-shape", nodeId: "shape-1", patch: { angle: 90 } });
  });
});

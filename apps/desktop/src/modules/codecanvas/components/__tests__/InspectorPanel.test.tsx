import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InspectorPanel } from "../InspectorPanel";

describe("InspectorPanel", () => {
  it("renders the property sections", () => {
    render(<InspectorPanel shape="rectangle" onPatch={() => {}} onArrange={() => {}} />);
    expect(screen.getByText("Stroke")).toBeTruthy();
    expect(screen.getByLabelText("Opacity")).toBeTruthy();
    expect(screen.getByRole("button", { name: /delete/i })).toBeTruthy();
  });

  it("emits a stroke-color style delta (not the merged style) so it can apply to many shapes", () => {
    const onPatch = vi.fn();
    render(<InspectorPanel shape="rectangle" style={{ opacity: 80 }} onPatch={onPatch} onArrange={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: "Stroke coral" }));
    expect(onPatch).toHaveBeenCalledWith({ style: { strokeColor: "#e8663d" } });
  });

  it("fires arrange actions", () => {
    const onArrange = vi.fn();
    render(<InspectorPanel shape="rectangle" onPatch={() => {}} onArrange={onArrange} />);
    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    expect(onArrange).toHaveBeenCalledWith("delete");
  });

  it("emits the assertive bold stroke width tier", () => {
    const onPatch = vi.fn();
    render(<InspectorPanel shape="rectangle" onPatch={onPatch} onArrange={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /extra bold/i }));
    expect(onPatch).toHaveBeenCalledWith({ style: { strokeWidth: 8 } });
  });

  it("edits text for a text shape", () => {
    const onPatch = vi.fn();
    render(<InspectorPanel shape="text" text="hi" onPatch={onPatch} onArrange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "hello" } });
    expect(onPatch).toHaveBeenCalledWith({ text: "hello" });
  });

  it("navigates a radio group with arrow keys (roving) and selects on move", () => {
    const onPatch = vi.fn();
    render(<InspectorPanel shape="rectangle" onPatch={onPatch} onArrange={() => {}} />);
    const group = screen.getByRole("radiogroup", { name: "Stroke color" });
    const radios = within(group).getAllByRole("radio");
    radios[0].focus();
    fireEvent.keyDown(group, { key: "ArrowRight" });
    expect(onPatch).toHaveBeenCalledWith({ style: { strokeColor: "#ffd43b" } }); // 2nd swatch
  });

  it("exposes a single roving tab stop per radio group (checked = tabindex 0, rest -1)", () => {
    render(<InspectorPanel shape="rectangle" onPatch={() => {}} onArrange={() => {}} />);
    const group = screen.getByRole("radiogroup", { name: "Stroke color" });
    const radios = within(group).getAllByRole("radio");
    const tabbable = radios.filter((r) => r.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
  });

  it("lets the user pick a custom stroke color beyond the presets", () => {
    const onPatch = vi.fn();
    render(<InspectorPanel shape="rectangle" onPatch={onPatch} onArrange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Custom stroke color"), { target: { value: "#123456" } });
    expect(onPatch).toHaveBeenCalledWith({ style: { strokeColor: "#123456" } });
  });

  it("lets the user pick a custom background color beyond the presets", () => {
    const onPatch = vi.fn();
    render(<InspectorPanel shape="rectangle" onPatch={onPatch} onArrange={() => {}} />);
    fireEvent.change(screen.getByLabelText("Custom background color"), { target: { value: "#0a0b0c" } });
    expect(onPatch).toHaveBeenCalledWith({ style: { fill: "#0a0b0c", fillStyle: "hachure" } });
  });

  it("shows Background for a container shape and hides it for text", () => {
    const { rerender } = render(<InspectorPanel shape="rectangle" onPatch={() => {}} onArrange={() => {}} />);
    expect(screen.getByText("Background")).toBeTruthy();
    rerender(<InspectorPanel shape="text" onPatch={() => {}} onArrange={() => {}} />);
    expect(screen.queryByText("Background")).toBeNull();
  });

  it("clears fill when the transparent background swatch is picked", () => {
    const onPatch = vi.fn();
    render(<InspectorPanel shape="rectangle" style={{ fill: "#3a2f1a" }} onPatch={onPatch} onArrange={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /transparent/i }));
    expect(onPatch).toHaveBeenCalledWith({ style: { fill: undefined, fillStyle: undefined } });
  });

  it("writes fill + fillStyle when a background color is picked", () => {
    const onPatch = vi.fn();
    render(<InspectorPanel shape="rectangle" onPatch={onPatch} onArrange={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /Background amber/i }));
    expect(onPatch).toHaveBeenCalledWith({ style: { fill: "#3a2f1a", fillStyle: "hachure" } });
  });

  it("omits stroke width and stroke style for the text shape", () => {
    render(<InspectorPanel shape="text" onPatch={() => {}} onArrange={() => {}} />);
    expect(screen.queryByText("Stroke width")).toBeNull();
    expect(screen.queryByText("Stroke style")).toBeNull();
  });

  it("shows Font and Size for any text-holding shape (text + containers) and hides them for linear", () => {
    const { rerender } = render(<InspectorPanel shape="text" onPatch={() => {}} onArrange={() => {}} />);
    expect(screen.getByText("Font")).toBeTruthy();
    expect(screen.getByText("Size")).toBeTruthy();
    rerender(<InspectorPanel shape="rectangle" onPatch={() => {}} onArrange={() => {}} />);
    expect(screen.getByText("Font")).toBeTruthy();
    expect(screen.getByText("Size")).toBeTruthy();
    rerender(<InspectorPanel shape="arrow" onPatch={() => {}} onArrange={() => {}} />);
    expect(screen.queryByText("Font")).toBeNull();
    expect(screen.queryByText("Size")).toBeNull();
  });

  it("patches fontFamily when a font is picked", () => {
    const onPatch = vi.fn();
    render(<InspectorPanel shape="text" onPatch={onPatch} onArrange={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /Font heading/i }));
    expect(onPatch).toHaveBeenCalledWith({ style: { fontFamily: "heading" } });
  });

  it("patches fontSize and textAlign for text", () => {
    const onPatch = vi.fn();
    render(<InspectorPanel shape="text" onPatch={onPatch} onArrange={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /Size L/i }));
    expect(onPatch).toHaveBeenCalledWith({ style: { fontSize: "L" } });
    fireEvent.click(screen.getByRole("radio", { name: /Align right/i }));
    expect(onPatch).toHaveBeenCalledWith({ style: { textAlign: "right" } });
    fireEvent.click(screen.getByRole("radio", { name: /Align bottom/i }));
    expect(onPatch).toHaveBeenCalledWith({ style: { verticalAlign: "bottom" } });
  });

  it("shows Arrow type for arrow + line, and Arrowheads only for arrow", () => {
    const { rerender } = render(<InspectorPanel shape="arrow" onPatch={() => {}} onArrange={() => {}} />);
    expect(screen.getByText("Arrow type")).toBeTruthy();
    expect(screen.getByText("Arrowheads")).toBeTruthy();
    rerender(<InspectorPanel shape="line" onPatch={() => {}} onArrange={() => {}} />);
    expect(screen.getByText("Arrow type")).toBeTruthy();
    expect(screen.queryByText("Arrowheads")).toBeNull();
    rerender(<InspectorPanel shape="rectangle" onPatch={() => {}} onArrange={() => {}} />);
    expect(screen.queryByText("Arrow type")).toBeNull();
  });

  it("patches the arrow type", () => {
    const onPatch = vi.fn();
    render(<InspectorPanel shape="arrow" onPatch={onPatch} onArrange={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /Arrow type elbow/i }));
    expect(onPatch).toHaveBeenCalledWith({ style: { arrowType: "elbow" } });
  });

  it("patches start and end arrowheads independently", () => {
    const onPatch = vi.fn();
    render(<InspectorPanel shape="arrow" onPatch={onPatch} onArrange={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /End triangle/i }));
    expect(onPatch).toHaveBeenCalledWith({ style: { endArrowhead: "triangle" } });
    fireEvent.click(screen.getByRole("radio", { name: /Start dot/i }));
    expect(onPatch).toHaveBeenCalledWith({ style: { startArrowhead: "dot" } });
  });

  it("shows no active option for a field flagged as mixed across a multi-selection", () => {
    render(
      <InspectorPanel
        shape="rectangle"
        style={{ strokeColor: "#e8663d" }}
        mixed={new Set(["strokeColor"])}
        onPatch={() => {}}
        onArrange={() => {}}
      />,
    );
    const checked = screen.getAllByRole("radio").filter((el) => el.getAttribute("aria-checked") === "true");
    expect(checked.some((el) => /^Stroke /.test(el.getAttribute("aria-label") ?? ""))).toBe(false);
  });

  it("renders the explicit sections override (multi-select intersection) and hides the label field", () => {
    render(
      <InspectorPanel
        shape="rectangle"
        sections={["stroke", "sloppiness", "opacity", "arrange"]}
        onPatch={() => {}}
        onArrange={() => {}}
      />,
    );
    expect(screen.queryByText("Background")).toBeNull();
    expect(screen.queryByLabelText("Area label")).toBeNull();
    expect(screen.getByText("Stroke")).toBeTruthy();
  });
});

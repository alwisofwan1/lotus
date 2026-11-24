import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SegmentedControl } from "../segmented-control";

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
] as const;

// motion caches the media query in a module singleton on first read, so stubbing matchMedia per
// test does nothing after the first one. Control the hook directly instead.
let reduceMotion = false;
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => reduceMotion,
}));

function setReducedMotion(reduce: boolean) {
  reduceMotion = reduce;
}

function renderControl(props: Partial<Parameters<typeof SegmentedControl<"a" | "b" | "c">>[0]> = {}) {
  const onChange = vi.fn();
  const utils = render(
    <SegmentedControl
      label="Mode"
      options={[...OPTIONS]}
      value="a"
      onChange={onChange}
      className="seg"
      buttonClassName="seg-btn"
      pillClassName="seg-pill"
      {...props}
    />,
  );
  return { ...utils, onChange };
}

afterEach(() => {
  reduceMotion = false;
});

describe("SegmentedControl", () => {
  it("is a named group of pressed-state buttons, one pressed", () => {
    setReducedMotion(false);
    renderControl({ value: "b" });
    const group = screen.getByRole("group", { name: "Mode" });
    expect(within(group).getByRole("button", { name: "Alpha" })).toHaveAttribute("aria-pressed", "false");
    expect(within(group).getByRole("button", { name: "Beta" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "Gamma" })).toHaveAttribute("aria-pressed", "false");
  });

  it("reports the clicked value", () => {
    setReducedMotion(false);
    const { onChange } = renderControl();
    fireEvent.click(screen.getByRole("button", { name: "Gamma" }));
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("hands the active fill to a hidden pill once measured", () => {
    setReducedMotion(false);
    const { container } = renderControl();
    const group = screen.getByRole("group", { name: "Mode" });
    expect(group).toHaveAttribute("data-pill", "on");
    const pill = container.querySelector(".seg-pill");
    expect(pill).not.toBeNull();
    expect(pill).toHaveAttribute("aria-hidden", "true");
  });

  it("renders no pill under reduced motion, so the pressed button keeps its own fill", () => {
    setReducedMotion(true);
    const { container } = renderControl();
    expect(screen.getByRole("group", { name: "Mode" })).not.toHaveAttribute("data-pill");
    expect(container.querySelector(".seg-pill")).toBeNull();
  });

  it("disables every segment and marks the group", () => {
    setReducedMotion(false);
    const { onChange } = renderControl({ disabled: true });
    const group = screen.getByRole("group", { name: "Mode" });
    expect(group).toHaveAttribute("data-disabled");
    for (const btn of within(group).getAllByRole("button")) expect(btn).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps one ResizeObserver across selections, so a click glides instead of snapping", () => {
    // A ResizeObserver fires once on observe(), and that callback snaps the pill. Re-creating the
    // observer per selection made every click snap — found in a browser, invisible to the DOM.
    setReducedMotion(false);
    const created = vi.fn();
    const Original = globalThis.ResizeObserver;
    vi.stubGlobal(
      "ResizeObserver",
      class extends Original {
        constructor(cb: ResizeObserverCallback) {
          super(cb);
          created();
        }
      },
    );
    const { rerender } = renderControl();
    const props = { label: "Mode", options: [...OPTIONS], onChange: () => {} };
    rerender(<SegmentedControl<"a" | "b" | "c"> {...props} value="b" />);
    rerender(<SegmentedControl<"a" | "b" | "c"> {...props} value="c" />);
    expect(created).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("carries no colour of its own — the skin comes from the caller's classes", () => {
    setReducedMotion(false);
    renderControl();
    // Planes' original painted zinc/white and `dark:` variants; Lotus themes need tokens instead.
    const html = screen.getByRole("group", { name: "Mode" }).outerHTML;
    expect(html).not.toMatch(/zinc-|bg-white|dark:|blur\(/);
  });
});

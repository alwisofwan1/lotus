import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { NumberStepper } from "../number-stepper";

// motion caches the media query in a module singleton; control the hook directly (see segmented-control).
let reduceMotion = false;
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  useReducedMotion: () => reduceMotion,
}));

function Harness({ initial = 250, onChange = () => {} }: { initial?: number; onChange?: (n: number) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <NumberStepper
      label="Debounce"
      min={0}
      max={1000}
      step={25}
      unit="ms"
      value={value}
      onChange={(n) => {
        setValue(n);
        onChange(n);
      }}
    />
  );
}

const field = () => screen.getByRole("spinbutton", { name: "Debounce" });
const minus = () => screen.getByRole("button", { name: "Decrease Debounce" });
const plus = () => screen.getByRole("button", { name: "Increase Debounce" });
const press = (el: HTMLElement) => {
  fireEvent.pointerDown(el, { button: 0 });
  fireEvent.pointerUp(el);
};

afterEach(() => {
  reduceMotion = false;
  vi.useRealTimers();
});

describe("NumberStepper", () => {
  it("is a named group around a spinbutton that reports its real bounds", () => {
    render(<Harness />);
    expect(screen.getByRole("group", { name: "Debounce" })).toBeInTheDocument();
    expect(field()).toHaveAttribute("aria-valuenow", "250");
    expect(field()).toHaveAttribute("aria-valuemin", "0");
    expect(field()).toHaveAttribute("aria-valuemax", "1000");
  });

  it("steps by the field's step on a press", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    press(plus());
    press(minus());
    press(minus());
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([275, 250, 225]);
  });

  it("disables each end exactly at its bound", () => {
    const { unmount } = render(<Harness initial={0} />);
    expect(minus()).toBeDisabled();
    expect(plus()).not.toBeDisabled();
    unmount();
    render(<Harness initial={1000} />);
    expect(plus()).toBeDisabled();
  });

  it("repeats while held and stops at the bound", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<Harness initial={900} onChange={onChange} />);
    fireEvent.pointerDown(plus(), { button: 0 });
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([925, 950, 975, 1000]);
    expect(plus()).toBeDisabled();
  });

  it("takes a typed value and clamps it on commit, not per keystroke", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "4" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(field(), { target: { value: "4000" } });
    fireEvent.blur(field());
    expect(onChange).toHaveBeenLastCalledWith(1000);
  });

  it("ignores a typed value that is not a number", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "abc" } });
    fireEvent.blur(field());
    expect(onChange).not.toHaveBeenCalled();
    expect(field()).toHaveValue("250");
  });

  it("answers the spinbutton keys", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.focus(field());
    for (const key of ["ArrowUp", "PageDown", "End", "Home"]) fireEvent.keyDown(field(), { key });
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([275, 25, 1000, 0]);
  });

  it("steps from the keyboard on Enter/Space without double-stepping a pointer press", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(plus(), { detail: 0 });
    press(plus());
    fireEvent.click(plus(), { detail: 1 });
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([275, 300]);
  });

  it("shows the rolling digits, not the typed text, after a key steps a focused field", () => {
    const { container } = render(<Harness />);
    fireEvent.focus(field());
    expect(container.querySelector(".ui-stepper__value")).not.toHaveAttribute("data-rolling");
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(container.querySelector(".ui-stepper__value")).toHaveAttribute("data-rolling");
    expect(container.querySelector(".ui-stepper__digits")).not.toBeNull();
  });

  it("draws plain digits under reduced motion", () => {
    reduceMotion = true;
    const { container } = render(<Harness />);
    expect(container.querySelector(".ui-stepper__digits")).toHaveTextContent("250");
    expect(container.querySelector(".ui-stepper__column")).toBeNull();
  });

  it("carries no colour of its own", () => {
    render(<Harness />);
    expect(screen.getByRole("group", { name: "Debounce" }).outerHTML).not.toMatch(/zinc-|bg-white|dark:|blur\(/);
  });
});

function Optional({
  initial = null,
  start,
  snap = false,
  onChange = () => {},
}: {
  initial?: number | null;
  start?: number;
  snap?: boolean;
  onChange?: (n: number | null) => void;
}) {
  const [value, setValue] = useState<number | null>(initial);
  return (
    <NumberStepper
      label="Timeout"
      min={1}
      max={240}
      step={5}
      page={60}
      snap={snap}
      unit="min"
      empty={{ label: start ? `${start} · default` : "no cap", start }}
      value={value}
      onChange={(n: number | null) => {
        setValue(n);
        onChange(n);
      }}
    />
  );
}

const tField = () => screen.getByRole("spinbutton", { name: "Timeout" });
const tMinus = () => screen.getByRole("button", { name: "Decrease Timeout" });
const tPlus = () => screen.getByRole("button", { name: "Increase Timeout" });

describe("NumberStepper · optional", () => {
  it("draws empty as what it means, with no number and no unit", () => {
    render(<Optional start={20} />);
    expect(screen.getByText("20 · default")).toBeInTheDocument();
    expect(screen.queryByText("min")).toBeNull();
    expect(tField()).not.toHaveAttribute("aria-valuenow");
    expect(tField()).toHaveAttribute("aria-valuetext", "20 · default");
    expect(tMinus()).toBeDisabled();
    expect(tPlus()).toBeEnabled();
  });

  it("starts + from the backend's default when there is one (D1)", () => {
    const onChange = vi.fn();
    render(<Optional start={20} onChange={onChange} />);
    press(tPlus());
    expect(onChange).toHaveBeenLastCalledWith(20);
  });

  it("starts + from the minimum when there is none (D1)", () => {
    const onChange = vi.fn();
    render(<Optional onChange={onChange} />);
    press(tPlus());
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it("− at the minimum returns to empty, and ArrowUp leaves it again (D2)", () => {
    const onChange = vi.fn();
    render(<Optional initial={1} onChange={onChange} />);
    press(tMinus());
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByText("no cap")).toBeInTheDocument();
    expect(tMinus()).toBeDisabled();

    fireEvent.keyDown(tField(), { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it("clearing the typed text commits empty (D2)", () => {
    const onChange = vi.fn();
    render(<Optional initial={45} onChange={onChange} />);
    fireEvent.focus(tField());
    fireEvent.change(tField(), { target: { value: "" } });
    fireEvent.blur(tField());
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("a required stepper ignores a cleared field, as before", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "" } });
    fireEvent.blur(field());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("typing into an empty field works and is clamped on commit", () => {
    const onChange = vi.fn();
    render(<Optional onChange={onChange} />);
    fireEvent.focus(tField());
    fireEvent.change(tField(), { target: { value: "300" } });
    fireEvent.keyDown(tField(), { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith(240);
  });

  it("disables + at the maximum, not before", () => {
    render(<Optional initial={240} />);
    expect(tPlus()).toBeDisabled();
    expect(tMinus()).toBeEnabled();
  });
});

describe("NumberStepper · snap (D3)", () => {
  it("lands on multiples of the step, both ways", () => {
    const onChange = vi.fn();
    render(<Optional initial={22} snap onChange={onChange} />);
    press(tPlus());
    press(tPlus());
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([25, 30]);

    onChange.mockClear();
    fireEvent.keyDown(tField(), { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith(25);
  });

  it("walks 1 → 5 rather than 1 → 6, and from 5 down to the minimum, then empty", () => {
    const onChange = vi.fn();
    render(<Optional initial={1} snap onChange={onChange} />);
    press(tPlus());
    press(tMinus());
    press(tMinus());
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([5, 1, null]);
  });

  it("pages by its own page size", () => {
    const onChange = vi.fn();
    render(<Optional initial={20} snap onChange={onChange} />);
    fireEvent.keyDown(tField(), { key: "PageUp" });
    expect(onChange).toHaveBeenLastCalledWith(60);
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FactoryRunCard } from "@/modules/factory/components/FactoryRunCard";
import { factoryRunView, type FactoryRunHandle, type FactoryRunView } from "@/modules/factory";

const opus = { id: "p1", name: "Claude opus" };
const sonnet = { id: "p2", name: "Claude sonnet" };

function handle(view: Partial<FactoryRunView> = {}, over: Partial<FactoryRunHandle> = {}): FactoryRunHandle {
  const v = { ...factoryRunView(null), ...view };
  return {
    view: v,
    checkout: "/code/lotus",
    loading: false,
    busy: false,
    error: null,
    canStart: v.canStart,
    start: vi.fn(async () => {}),
    raiseCap: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    ...over,
  };
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* no storage in this runner */
  }
});

describe("FactoryRunCard — no run yet", () => {
  it("invites a run and starts it as the chosen preset", () => {
    const run = handle();
    render(<FactoryRunCard run={run} presets={[opus, sonnet]} />);
    expect(screen.getByText("Let an agent fix this")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Implementer for the Factory Run"), { target: { value: "p2" } });
    fireEvent.click(screen.getByRole("button", { name: "Run in Factory" }));
    expect(run.start).toHaveBeenCalledWith("p2");
  });

  it("remembers the implementer picked last time", () => {
    const first = render(<FactoryRunCard run={handle()} presets={[opus, sonnet]} />);
    fireEvent.change(screen.getByLabelText("Implementer for the Factory Run"), { target: { value: "p2" } });
    first.unmount();
    const run = handle();
    render(<FactoryRunCard run={run} presets={[opus, sonnet]} />);
    fireEvent.click(screen.getByRole("button", { name: "Run in Factory" }));
    expect(run.start).toHaveBeenCalledWith("p2");
  });

  it("falls back to the first preset when the remembered one is gone", () => {
    render(<FactoryRunCard run={handle()} presets={[opus, sonnet]} />);
    fireEvent.change(screen.getByLabelText("Implementer for the Factory Run"), { target: { value: "p2" } });
    const run = handle();
    render(<FactoryRunCard run={run} presets={[opus]} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Run in Factory" }).at(-1)!);
    expect(run.start).toHaveBeenCalledWith("p1");
  });

  it("cannot start with no Claude preset, and says what to do", () => {
    render(<FactoryRunCard run={handle()} presets={[]} />);
    expect(screen.getByRole("button", { name: "Run in Factory" })).toBeDisabled();
    expect(screen.getByText(/Make a Claude preset first/)).toBeInTheDocument();
  });

  it("cannot start with no checkout, and says why", () => {
    render(<FactoryRunCard run={handle({}, { checkout: null, canStart: false })} presets={[opus]} />);
    expect(screen.getByRole("button", { name: "Run in Factory" })).toBeDisabled();
    expect(screen.getByText(/No open workspace holds a checkout/)).toBeInTheDocument();
  });

  it("shows why the last start did not happen", () => {
    render(<FactoryRunCard run={handle({}, { error: "the repo declares no gate" })} presets={[opus]} />);
    expect(screen.getByRole("alert")).toHaveTextContent("the repo declares no gate");
  });
});

describe("FactoryRunCard — a run exists", () => {
  const progress = { stage: "checking" as const, attempt: 1, maxAttempts: 2, steps: [] };

  it("shows the status word, the sentence and the bar, the same as the Factory", () => {
    render(<FactoryRunCard run={handle({ state: "running", canStart: false, canAbort: true, progress })} presets={[opus]} />);
    expect(screen.getByText("Working")).toHaveAttribute("data-group", "working");
    expect(screen.getByText("Checking · try 1 of 2")).toBeInTheDocument();
    const segments = [...document.querySelectorAll(".fa-bar-seg")].map((s) => s.getAttribute("data-status"));
    expect(segments).toEqual(["done", "done", "done", "done", "active", "todo", "todo"]);
  });

  it("opens the run in Factory, and has no other action", () => {
    const onOpenInFactory = vi.fn();
    render(
      <FactoryRunCard
        run={handle({ state: "check-failed", output: "tsc: 2 errors", progress })}
        presets={[opus]}
        onOpenInFactory={onOpenInFactory}
      />,
    );
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run in Factory" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Open in Factory/ }));
    expect(onOpenInFactory).toHaveBeenCalledTimes(1);
  });

  it("shows where its PR stands and opens the Chief of Staff on it (CoS 10)", () => {
    const onOpenInChief = vi.fn();
    const prWatch = {
      number: 9,
      url: "https://github.com/o/r/pull/9",
      phase: "waiting-for-review" as const,
      seen: { review: 0, reviewComment: 0, comment: 0 },
      rounds: [{ round: 1, runId: "r", startedAt: 0, items: ["line:21"], ended: "pushed" as const }],
      feedback: [{ id: "line:21", source: "review-comment" as const, author: "rev", counts: true, body: "x", at: 0, status: "not-addressed" as const, batch: 1 }],
    };
    render(<FactoryRunCard run={handle({ state: "done", prWatch })} presets={[opus]} onOpenInFactory={vi.fn()} onOpenInChief={onOpenInChief} />);
    expect(screen.getByText("PR #9 · Round 1 of 3 · waiting for review · 1 needs you")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open in Chief of Staff/ }));
    expect(onOpenInChief).toHaveBeenCalledTimes(1);
  });

  it("without a watched PR there is no PR line and no Chief of Staff link", () => {
    render(<FactoryRunCard run={handle({ state: "done" })} presets={[opus]} onOpenInChief={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Open in Chief of Staff/ })).toBeNull();
  });

  it("says it is reading before the run is known", () => {
    render(<FactoryRunCard run={handle({}, { loading: true })} presets={[opus]} />);
    expect(screen.getByText("Reading…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run in Factory" })).toBeNull();
  });
});

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PlanNodeCard } from "../PlanNodeCard";
import type { AgentStatusSnapshot } from "../../../services/agent-status-registry";
import type { CanvasPlanStep } from "../../../types/canvas";

const steps: CanvasPlanStep[] = [
  { title: "Build API", owner: "Backend" },
  { title: "Write docs", done: true },
];
const roster: AgentStatusSnapshot[] = [
  { id: "be", name: "Backend Engineer", status: "running" },
  { id: "fe", name: "Frontend Engineer", status: "completed" },
];

describe("PlanNodeCard", () => {
  it("renders the title, steps, and a progress count (short owner resolves to full agent)", () => {
    render(<PlanNodeCard title="Sprint 1" steps={steps} roster={roster} onSync={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Sprint 1")).toBeInTheDocument();
    expect(screen.getByText("Build API")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument(); // docs done (manual), API running
  });

  it("syncs from plan.md on click", () => {
    const onSync = vi.fn();
    render(<PlanNodeCard title="P" steps={steps} roster={roster} onSync={onSync} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Sync from plan.md" }));
    expect(onSync).toHaveBeenCalledOnce();
  });

  it("shows an empty hint when there are no steps", () => {
    render(<PlanNodeCard title="P" steps={[]} roster={roster} onSync={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/no steps/i)).toBeInTheDocument();
  });

  it("surfaces the sync outcome instead of failing silently", () => {
    const { rerender } = render(
      <PlanNodeCard title="P" steps={[]} roster={roster} onSync={() => {}} onClose={() => {}} />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    rerender(
      <PlanNodeCard
        title="P"
        steps={[]}
        roster={roster}
        syncStatus={{ kind: "empty", message: 'plan.md has no checklist steps — use "- [ ] task (owner: Name)".' }}
        onSync={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("no checklist steps");
  });

  it("lets the user rebind a step owner to a specific agent", () => {
    const onBindOwner = vi.fn();
    render(
      <PlanNodeCard title="P" steps={steps} roster={roster} onSync={() => {}} onClose={() => {}} onBindOwner={onBindOwner} />,
    );
    const picker = screen.getByLabelText("Owner for Backend") as HTMLSelectElement;
    fireEvent.change(picker, { target: { value: "fe" } });
    expect(onBindOwner).toHaveBeenCalledWith("Backend", "fe");
  });

  it("flags an unresolvable owner so the user knows to bind it", () => {
    const orphan: CanvasPlanStep[] = [{ title: "Ship", owner: "Nobody" }];
    render(<PlanNodeCard title="P" steps={orphan} roster={roster} onSync={() => {}} onClose={() => {}} onBindOwner={vi.fn()} />);
    expect((screen.getByLabelText("Owner for Nobody") as HTMLSelectElement).className).toContain("unresolved");
    expect(screen.getByText("1 unbound")).toBeInTheDocument();
  });

  it("disables Run when no plan owner matches a live agent and surfaces runner errors", () => {
    const orphan: CanvasPlanStep[] = [{ title: "Ship", owner: "Nobody" }];
    render(
      <PlanNodeCard title="P" steps={orphan} roster={roster} onSync={() => {}} onClose={() => {}} onRunPlan={vi.fn()} runError="No owner matched" />,
    );
    expect(screen.getByRole("button", { name: "Run plan" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("No owner matched");
  });

  it("runs the plan on click and disables while running", () => {
    const onRunPlan = vi.fn();
    const { rerender } = render(
      <PlanNodeCard title="P" steps={steps} roster={roster} onSync={() => {}} onClose={() => {}} onRunPlan={onRunPlan} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run plan" }));
    expect(onRunPlan).toHaveBeenCalledOnce();
    rerender(<PlanNodeCard title="P" steps={steps} roster={roster} onSync={() => {}} onClose={() => {}} onRunPlan={onRunPlan} running />);
    expect(screen.getByRole("button", { name: "Run plan" })).toBeDisabled();
  });
});

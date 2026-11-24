import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskFilterBar } from "@/modules/tasks/components/TaskFilterBar";
import { ME, filterOptions, type FilterIdentity, type TaskFilterRule } from "@/modules/tasks/services/task-filters";
import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";

const board: TrackerProject = { id: "n", name: "Orbit Meeting Tasks", prefix: "", vocabulary: LOTUS_VOCABULARY };
const alwi = { id: "u-alwi", name: "Alwi Sofwan" };
const diva = { id: "u-diva", name: "Diva Puteri" };
const tasks: TrackerTask[] = [
  { id: "a", projectId: "n", title: "a", status: "todo", priority: "none", createdAt: 1, updatedAt: 1, assignees: [alwi] },
  { id: "b", projectId: "n", title: "b", status: "todo", priority: "none", createdAt: 1, updatedAt: 1, assignees: [diva] },
];

function Harness({ onMe = vi.fn(), initialMe = null }: { onMe?: (me: FilterIdentity | null) => void; initialMe?: FilterIdentity | null }) {
  const [rules, setRules] = useState<TaskFilterRule[]>([]);
  const [me, setMe] = useState<FilterIdentity | null>(initialMe);
  return (
    <>
      <TaskFilterBar
        rules={rules}
        onRulesChange={setRules}
        properties={["status", "assignee"]}
        optionsFor={(property) => filterOptions(property, tasks, [board])}
        me={me}
        onSetMe={(next) => {
          setMe(next);
          onMe(next);
        }}
        sort="priority"
        onSortChange={vi.fn()}
        query=""
        onQueryChange={vi.fn()}
        hideDone={false}
        onHideDoneChange={vi.fn()}
      />
      <output data-testid="rules">{JSON.stringify(rules.map(({ property, operator, values }) => ({ property, operator, values })))}</output>
    </>
  );
}

const rulesNow = () => JSON.parse(screen.getByTestId("rules").textContent ?? "[]");
const addFilter = (name: RegExp) => {
  fireEvent.click(screen.getByLabelText(/^Filter(, \d+ active)?$/));
  const open = screen.getAllByRole("group", { name: "Filter by property" }).find((menu) => menu.closest("details")!.open)!;
  fireEvent.click(within(open).getByRole("button", { name }));
};

describe("TaskFilterBar", () => {
  it("draws no second row until a filter exists", () => {
    render(<Harness />);
    expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();
  });

  it("+ Filter → Assignee opens the new rule straight onto its people", () => {
    render(<Harness />);
    addFilter(/Assignee/);

    const menu = screen.getByRole("group", { name: "Filter by assignee" });
    expect(menu.closest("details")!.open).toBe(true);
    expect(within(menu).getByRole("button", { name: /Alwi Sofwan/ })).toBeTruthy();
    expect(screen.getByLabelText("Assignee filter, not set")).toBeTruthy();
  });

  it("asks once who Me is, then filters by it and names the chip Me", () => {
    const onMe = vi.fn();
    render(<Harness onMe={onMe} />);
    addFilter(/Assignee/);
    const menu = () => within(screen.getByRole("group", { name: "Filter by assignee" }));

    fireEvent.click(menu().getByRole("button", { name: /^Me/ }));
    fireEvent.click(within(screen.getByRole("group", { name: "Which one is you?" })).getByRole("button", { name: /Alwi Sofwan/ }));

    expect(onMe).toHaveBeenCalledWith(alwi);
    expect(rulesNow()).toEqual([{ property: "assignee", operator: "contains", values: [ME] }]);
    expect(screen.getByLabelText("Assignee: Me")).toBeTruthy();
  });

  it("types to narrow, Enter to pick, Backspace to take the last token back", () => {
    render(<Harness initialMe={alwi} />);
    addFilter(/Assignee/);
    const input = screen.getByLabelText("Search assignee");

    fireEvent.change(input, { target: { value: "div" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(rulesNow()[0].values).toEqual([diva.id]);
    expect(screen.getByLabelText("Assignee: Diva Puteri")).toBeTruthy();

    fireEvent.keyDown(input, { key: "Backspace" });
    expect(rulesNow()[0].values).toEqual([]);
  });

  it("changes the operator, and an empty-check needs no values", () => {
    render(<Harness />);
    addFilter(/Assignee/);
    fireEvent.click(screen.getByRole("button", { name: /contains/ }));
    fireEvent.click(screen.getByRole("option", { name: /is empty/ }));

    expect(rulesNow()).toEqual([{ property: "assignee", operator: "empty", values: [] }]);
    expect(screen.getByLabelText("Assignee: is empty")).toBeTruthy();
    expect(screen.getByLabelText("Filter, 1 active")).toBeTruthy();
  });

  it("deletes a rule from its … menu, and Clear drops them all", () => {
    render(<Harness />);
    addFilter(/Status/);
    fireEvent.click(screen.getByRole("button", { name: "Filter actions" }));
    fireEvent.click(screen.getByRole("button", { name: /Delete filter/ }));
    expect(rulesNow()).toEqual([]);

    addFilter(/Status/);
    addFilter(/Assignee/);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(rulesNow()).toEqual([]);
  });
});

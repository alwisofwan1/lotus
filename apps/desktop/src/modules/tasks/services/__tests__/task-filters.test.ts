import { describe, expect, it } from "vitest";
import {
  ME,
  applyFilterRules,
  availableProperties,
  filterOptions,
  readFilterRules,
  ruleSummary,
  type TaskFilterRule,
} from "@/modules/tasks/services/task-filters";
import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import { VAULT_VOCABULARY } from "@/modules/tasks/services/vault-vocabulary";
import { VAULT_CAPABILITIES } from "@/modules/tasks/services/vault-mapping";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";

const lotus: TrackerProject = { id: "ws", name: "Lotus", prefix: "LOT", vocabulary: LOTUS_VOCABULARY };
const vault: TrackerProject = { id: "vault", name: "Vault", prefix: "", vocabulary: VAULT_VOCABULARY, capabilities: VAULT_CAPABILITIES };

function task(id: string, patch: Partial<TrackerTask> = {}): TrackerTask {
  return { id, projectId: "ws", title: id, status: "todo", priority: "none", createdAt: 1, updatedAt: 1, ...patch };
}

const alwi = { id: "u-alwi", name: "Alwi Sofwan" };
const diva = { id: "u-diva", name: "Diva Puteri" };
const rule = (patch: Partial<TaskFilterRule>): TaskFilterRule => ({ id: "r", property: "status", operator: "is", values: [], ...patch });

describe("applyFilterRules", () => {
  const tasks = [
    task("mine", { assignees: [alwi], labels: ["bug"] }),
    task("hers", { assignees: [diva], status: "in-review", labels: [] }),
    task("nobody", { assignees: [] }),
    task("lotus-task"),
  ];
  const ids = (rules: TaskFilterRule[], me = alwi) => applyFilterRules(tasks, rules, me).map((t) => t.id);

  it("a rule with no values yet hides nothing", () => {
    expect(ids([rule({ values: [] })])).toHaveLength(4);
  });

  it("ORs the values inside one rule and ANDs the rules", () => {
    expect(ids([rule({ values: ["todo", "in-review"] })])).toHaveLength(4);
    expect(ids([rule({ values: ["todo"] }), rule({ id: "a", property: "assignee", operator: "contains", values: [alwi.id] })])).toEqual(["mine"]);
  });

  it("resolves Me at filter time, and matches nobody while Me is unknown", () => {
    const me = [rule({ property: "assignee", operator: "contains", values: [ME] })];
    expect(ids(me)).toEqual(["mine"]);
    expect(ids(me, diva)).toEqual(["hers"]);
    expect(applyFilterRules(tasks, me, null)).toEqual([]);
  });

  it("says the negative and the empty operators the way they read", () => {
    expect(ids([rule({ property: "assignee", operator: "not_contains", values: [ME] })])).toEqual(["hers", "nobody", "lotus-task"]);
    expect(ids([rule({ property: "assignee", operator: "empty" })])).toEqual(["nobody", "lotus-task"]);
    expect(ids([rule({ property: "label", operator: "not_empty" })])).toEqual(["mine"]);
    expect(ids([rule({ operator: "is_not", values: ["todo"] })])).toEqual(["hers"]);
  });
});

describe("filterOptions", () => {
  it("groups statuses by whose words they are, and offers a shared word once", () => {
    const options = filterOptions("status", [task("a")], [lotus, vault]);
    const todo = options.filter((o) => o.value === "todo");
    expect(todo).toHaveLength(1);
    expect(todo[0].group).toBe("Lotus");
    expect(options.find((o) => o.value === "qa-revision")?.group).toBe("Vault");
  });

  it("does not group a single vocabulary, however many projects speak it", () => {
    const other = { ...lotus, id: "ws2", name: "Other" };
    expect(filterOptions("status", [], [lotus, other]).every((o) => o.group === undefined)).toBe(true);
  });

  it("lists the people in view by name, with how many tasks each is on", () => {
    const options = filterOptions("assignee", [task("a", { assignees: [diva, alwi] }), task("b", { assignees: [alwi] })], [lotus]);
    expect(options.map((o) => [o.label, o.count])).toEqual([["Alwi Sofwan", 2], ["Diva Puteri", 1]]);
  });
});

describe("availableProperties", () => {
  it("offers only what a task in view can have", () => {
    expect(availableProperties([task("a")], [lotus])).toEqual(["status", "priority"]);
    expect(availableProperties([task("a", { assignees: [], labels: [] })], [vault, lotus])).toEqual([
      "status", "assignee", "label", "priority", "project",
    ]);
  });
});

describe("ruleSummary", () => {
  const labelOf = (v: string) => (v === ME ? "Me" : v);
  it("leaves the default operator unsaid and says every other", () => {
    expect(ruleSummary(rule({ property: "assignee", operator: "contains", values: [ME] }), labelOf)).toEqual({ property: "Assignee", detail: "Me" });
    expect(ruleSummary(rule({ operator: "is_not", values: ["Done"] }), labelOf).detail).toBe("is not Done");
    expect(ruleSummary(rule({ property: "label", operator: "empty" }), labelOf).detail).toBe("is empty");
    expect(ruleSummary(rule({}), labelOf).detail).toBeNull();
  });
});

describe("readFilterRules", () => {
  it("keeps what looks like a rule and repairs or drops the rest", () => {
    const read = readFilterRules([
      { id: "a", property: "assignee", operator: "contains", values: ["x", 3] },
      { id: "b", property: "status", operator: "contains", values: [] },
      { property: "nonsense" },
      "junk",
    ]);
    expect(read).toEqual([
      { id: "a", property: "assignee", operator: "contains", values: ["x"] },
      { id: "b", property: "status", operator: "is", values: [] },
    ]);
    expect(readFilterRules(null)).toEqual([]);
  });
});

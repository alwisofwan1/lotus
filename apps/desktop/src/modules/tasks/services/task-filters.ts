import {
  LOTUS_VOCABULARY,
  statusLabel,
  statusTone,
  TASK_PRIORITY_ORDER,
  taskPriorityLabel,
  type StatusVocabulary,
  type TaskStatusTone,
} from "@/modules/tasks/services/task-vocabulary";
import { capabilitiesOf, type TrackerProject, type TrackerTask } from "@/modules/tasks/types";

/**
 * Filters as Notion draws them: a row of rules, each one property, one operator, some values.
 *
 * Rules AND together, values inside one rule OR together — "Status is Todo, In review" AND
 * "Assignee contains Me". That is the shape Notion's simple filters settled on and the shape people
 * arrive already knowing, so it is copied rather than improved.
 *
 * A rule with no values yet filters NOTHING. It exists the moment someone picks "+ Filter → Status",
 * before they have chosen a status, and a list that emptied itself at that instant would punish the
 * first half of a gesture.
 */

export type FilterProperty = "status" | "assignee" | "label" | "priority" | "project";

/**
 * `is`/`is_not` for a property a task has ONE of (status, priority, project); `contains`/
 * `not_contains` for one it has several of (people, labels). `empty`/`not_empty` for both of the
 * latter — "nobody is on it" is a question worth one click.
 */
export type FilterOperator = "is" | "is_not" | "contains" | "not_contains" | "empty" | "not_empty";

export interface TaskFilterRule {
  /** Stable across edits, so React keeps the chip (and its open popover) while its values change. */
  id: string;
  property: FilterProperty;
  operator: FilterOperator;
  /** Status words, person ids, labels, priorities, project ids — whatever the property compares. */
  values: string[];
}

/** Who "Me" is. Chosen once by the person, because the Notion token is a bot, not them. */
export interface FilterIdentity {
  id: string;
  name: string;
}

/** The value that stands for whoever "Me" is — resolved at filter time, so it follows a change. */
export const ME = "@me";

export const FILTER_PROPERTIES: readonly FilterProperty[] = ["status", "assignee", "label", "priority", "project"];

export const PROPERTY_LABEL: Record<FilterProperty, string> = {
  status: "Status",
  assignee: "Assignee",
  label: "Labels",
  priority: "Priority",
  project: "Project",
};

const MULTI: ReadonlySet<FilterProperty> = new Set(["assignee", "label"]);

/** The operators a property offers, in the order its menu lists them. */
export function operatorsFor(property: FilterProperty): FilterOperator[] {
  return MULTI.has(property) ? ["contains", "not_contains", "empty", "not_empty"] : ["is", "is_not"];
}

export function defaultOperator(property: FilterProperty): FilterOperator {
  return operatorsFor(property)[0];
}

export const OPERATOR_LABEL: Record<FilterOperator, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  not_contains: "does not contain",
  empty: "is empty",
  not_empty: "is not empty",
};

/** An operator that needs no values: the chip is whole the moment it is chosen. */
export function operatorTakesValues(operator: FilterOperator): boolean {
  return operator !== "empty" && operator !== "not_empty";
}

/** Does this rule filter anything yet? */
export function ruleIsActive(rule: TaskFilterRule): boolean {
  return !operatorTakesValues(rule.operator) || rule.values.length > 0;
}

/** What a task has for a property, as the strings rules compare. */
function valuesOf(task: TrackerTask, property: FilterProperty): string[] {
  switch (property) {
    case "status":
      return [task.status];
    case "priority":
      return [task.priority];
    case "project":
      return [task.projectId];
    case "assignee":
      return (task.assignees ?? []).map((person) => person.id);
    case "label":
      return task.labels ?? [];
  }
}

function matchesRule(task: TrackerTask, rule: TaskFilterRule, me: FilterIdentity | null): boolean {
  if (!ruleIsActive(rule)) return true;
  const has = valuesOf(task, rule.property);
  // "Me" before anyone has said who they are matches nobody — never everybody.
  const wanted = rule.values.flatMap((value) => (value === ME ? (me ? [me.id] : []) : [value]));
  const any = wanted.some((value) => has.includes(value));
  switch (rule.operator) {
    case "is":
    case "contains":
      return any;
    case "is_not":
    case "not_contains":
      return !any;
    case "empty":
      return has.length === 0;
    case "not_empty":
      return has.length > 0;
  }
}

export function applyFilterRules(
  tasks: readonly TrackerTask[],
  rules: readonly TaskFilterRule[],
  me: FilterIdentity | null = null,
): TrackerTask[] {
  const active = rules.filter(ruleIsActive);
  if (active.length === 0) return [...tasks];
  return tasks.filter((task) => active.every((rule) => matchesRule(task, rule, me)));
}

export interface FilterOption {
  value: string;
  label: string;
  /** Which project's words these are — set only when the view spans more than one vocabulary. */
  group?: string;
  /** For a status: the tone its glyph is drawn in, and the vocabulary that draws it. */
  tone?: TaskStatusTone;
  vocabulary?: StatusVocabulary;
  /** For a project: its dot. */
  color?: string;
  /** How many tasks in view have it. */
  count: number;
}

/**
 * What a property's menu offers in this view, drawn from the tasks and projects in it.
 *
 * Options come from the VIEW, not from the whole board: the Assignee menu of one Notion board lists
 * that board's people, and "All tasks" lists everyone. A status nobody is in is still offered when
 * its project names it, because "show me what is Blocked" is a fair question with the answer zero.
 */
export function filterOptions(
  property: FilterProperty,
  tasks: readonly TrackerTask[],
  projects: readonly TrackerProject[],
): FilterOption[] {
  const count = (value: string) => tasks.filter((task) => valuesOf(task, property).includes(value)).length;

  if (property === "status") {
    const speaking = projects.length > 0 ? projects : [{ name: "", vocabulary: LOTUS_VOCABULARY } as TrackerProject];
    // Projects that speak the same words (every workspace speaks Lotus's) are one group, not N.
    const seenVocab = new Map<StatusVocabulary, string[]>();
    for (const project of speaking) {
      const names = seenVocab.get(project.vocabulary);
      if (names) names.push(project.name);
      else seenVocab.set(project.vocabulary, [project.name]);
    }
    const grouped = seenVocab.size > 1;
    const seen = new Set<string>();
    const options: FilterOption[] = [];
    for (const [vocabulary, names] of seenVocab) {
      for (const status of vocabulary.order) {
        // `todo` means the same thing to a workspace and to the vault: offered once, under the first.
        if (seen.has(status)) continue;
        seen.add(status);
        options.push({
          value: status,
          label: statusLabel(vocabulary, status),
          tone: statusTone(vocabulary, status),
          vocabulary,
          ...(grouped ? { group: groupName(names) } : {}),
          count: count(status),
        });
      }
    }
    return options;
  }

  if (property === "priority") {
    return TASK_PRIORITY_ORDER.map((priority) => ({
      value: priority,
      label: taskPriorityLabel(priority),
      count: count(priority),
    }));
  }

  if (property === "project") {
    return projects.map((project) => ({
      value: project.id,
      label: project.name,
      ...(project.color ? { color: project.color } : {}),
      count: count(project.id),
    }));
  }

  if (property === "assignee") {
    const people = new Map<string, string>();
    for (const task of tasks) for (const person of task.assignees ?? []) people.set(person.id, person.name || person.id);
    return [...people]
      .map(([value, label]) => ({ value, label, count: count(value) }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }

  const labels = new Set(tasks.flatMap((task) => task.labels ?? []));
  return [...labels]
    .sort((left, right) => left.localeCompare(right))
    .map((value) => ({ value, label: value, count: count(value) }));
}

function groupName(names: string[]): string {
  return names.length <= 2 ? names.join(", ") : `${names[0]} + ${names.length - 1} more`;
}

/**
 * The properties "+ Filter" offers in this view. A property no task here can have is left out:
 * "Assignee" over a list of Lotus tasks, which carry nobody, would be a menu of nothing.
 */
export function availableProperties(
  tasks: readonly TrackerTask[],
  projects: readonly TrackerProject[],
): FilterProperty[] {
  return FILTER_PROPERTIES.filter((property) => {
    switch (property) {
      case "status":
        return true;
      case "priority":
        return projects.some((project) => capabilitiesOf(project).hasPriority);
      case "project":
        return projects.length > 1;
      case "assignee":
        return tasks.some((task) => task.assignees !== undefined);
      case "label":
        return tasks.some((task) => task.labels !== undefined);
    }
  });
}

/**
 * The chip's own words: `Status: In Review, Todo`, `Assignee: Me`, `Labels is empty`.
 *
 * `is` and `contains` are left unsaid, because they are what a chip means by default — Notion
 * prints them the same way. Every other operator is said, since reading "Status: Done" over a rule
 * that HIDES done work would be a lie told in the one place people look.
 */
export function ruleSummary(
  rule: TaskFilterRule,
  labelOf: (value: string) => string,
): { property: string; detail: string | null } {
  const property = PROPERTY_LABEL[rule.property];
  if (!operatorTakesValues(rule.operator)) return { property, detail: OPERATOR_LABEL[rule.operator] };
  if (rule.values.length === 0) return { property, detail: null };
  const values = rule.values.map(labelOf).join(", ");
  const plain = rule.operator === "is" || rule.operator === "contains";
  return { property, detail: plain ? values : `${OPERATOR_LABEL[rule.operator]} ${values}` };
}

/** Where a view keeps its filters: `all`, `active`, or a project id. */
export function filterViewKey(selection: string | null | "active"): string {
  return selection === null ? "all" : selection;
}

let counter = 0;
export function newRuleId(): string {
  counter += 1;
  return `f${Date.now().toString(36)}${counter.toString(36)}`;
}

/** A stored rule list, or none: anything that does not look like one is dropped, never thrown on. */
export function readFilterRules(value: unknown): TaskFilterRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): TaskFilterRule[] => {
    if (!item || typeof item !== "object") return [];
    const rule = item as Partial<Record<keyof TaskFilterRule, unknown>>;
    const property = rule.property as FilterProperty;
    if (!FILTER_PROPERTIES.includes(property)) return [];
    const operator = operatorsFor(property).includes(rule.operator as FilterOperator)
      ? (rule.operator as FilterOperator)
      : defaultOperator(property);
    const values = Array.isArray(rule.values) ? rule.values.filter((v): v is string => typeof v === "string") : [];
    return [{ id: typeof rule.id === "string" && rule.id ? rule.id : newRuleId(), property, operator, values }];
  });
}

/**
 * The layout a person arranged, kept across restarts.
 *
 * This is the SHELL's own state — seam sizes, which rail is open, which mode was last used. It
 * deliberately holds nothing about sessions: no pane ids, no thread ids, no cwd. A stored
 * layout must never be able to resurrect, rename or mislabel work.
 *
 * Parsing is defensive because this value comes back from a browser store that a user, another
 * build, or a corrupted profile can have written: anything unrecognised falls back to the
 * default rather than throwing on boot.
 */

import { clampSplitSize } from "@/modules/workspace-shell/services/split-sizing";
import type { ShellMode } from "@/modules/workspace-shell/types";
import type { TaskSort } from "@/modules/tasks/services/task-list";
import { readFilterRules, type FilterIdentity, type TaskFilterRule } from "@/modules/tasks/services/task-filters";

/** The Factory panel's tabs, as `FactorySurface` names them. */
const FACTORY_TABS = ["runs", "board", "chief", "agents", "insights"] as const;
export type FactoryTab = (typeof FACTORY_TABS)[number];
const isFactoryTab = (value: unknown): value is FactoryTab => FACTORY_TABS.includes(value as FactoryTab);

/** Every sort a stored layout may name; anything else falls back to the default. */
const TASK_SORTS: readonly TaskSort[] = ["priority", "recent", "number", "manual"];

export const LAYOUT_STORAGE_KEY = "lotus.workspace-shell.layout.v1";

export interface ShellLayoutPreferences {
  mode: Exclude<ShellMode, "canvas">;
  railVisible: boolean;
  railWidth: number;
  terminalWidth: number;
  browserHeight: number;
  /**
   * Which folders are EXPANDED — plural on purpose.
   *
   * Expansion used to be derived from the active workspace, so opening a second folder collapsed
   * the first one under the cursor. It is a view preference of its own now, and the active
   * workspace is a separate thing entirely.
   */
  openWorkspaceIds: string[];
  /** Folders kept at the top of the rail; see `orderRailWorkspaces`. */
  pinnedWorkspaceIds: string[];
  /**
   * Is the tracker open over the mode surface?
   *
   * A panel, not a mode: Tasks is reached from the rail, the way `bb` reaches it from its sidebar,
   * and the mode underneath stays mounted while it is open — closing the tracker must not cost a
   * terminal. Stored so the window opens where it was left.
   */
  tasksOpen: boolean;
  /** Whether the Automation panel is open. Same kind of panel as Tasks; at most one is open. */
  automationOpen: boolean;
  /** Whether the Connectors panel is open. Same kind again; at most one panel is open. */
  connectorsOpen: boolean;
  /** Whether the Factory panel is open. Same kind again; at most one panel is open. */
  factoryOpen: boolean;
  /** The Factory tab last shown, so the panel opens on the same view. */
  factoryTab: FactoryTab;
  /** Width of Automation's channel sidebar (Inbox, then one row per automation). */
  automationNavWidth: number;
  /** Width of Automation's right pane: the open review, Settings, or a preview. */
  automationPaneWidth: number;
  /** Width of the tracker's own navigation column, which is its own thing to drag. */
  taskNavWidth: number;
  /** Whether that column is shown. Hidden gives a long brief the whole width to be read in. */
  taskNavVisible: boolean;
  /** Whether the tracker hides finished work — each project's own "finished", not Lotus's. */
  taskHideDone: boolean;
  /** How the tracker orders rows inside a section — including `manual`, the order set by hand. */
  taskSort: TaskSort;
  /**
   * A vault's manual order, by ticket FILE. Kept here, on Lotus's side, because writing it into the
   * tickets would add a field the human's Dataview board never reads to every obsidian-git commit.
   */
  ticketOrder: Record<string, number>;
  /**
   * The tracker prefix each project was given, by workspace id.
   *
   * Stored rather than derived on every render, and that is the whole point: `INT-2` is a name
   * people say and paste, so it must survive the folder being renamed. Derivation only ever
   * happens ONCE per project — when it is first seen — and the answer is kept here.
   *
   * It lives in shell preferences rather than in the workspace snapshot because a prefix is what
   * this window calls a project in its tracker, not a property of the folder on disk.
   */
  taskPrefixes: Record<string, string>;
  /**
   * Each view's filters — `all`, `active`, or a project id — as Notion keeps a filter per view.
   * Kept so a board filtered to "Assignee contains Me" opens that way tomorrow.
   */
  taskFilters: Record<string, TaskFilterRule[]>;
  /** Who "Me" is in Filters. The Notion token is a bot, so the person says it once. */
  taskMe: FilterIdentity | null;
}

export const LAYOUT_BOUNDS = {
  railWidth: { min: 232, max: 520 },
  taskNavWidth: { min: 210, max: 480 },
  automationNavWidth: { min: 180, max: 360 },
  automationPaneWidth: { min: 340, max: 960 },
  terminalWidth: { min: 320, max: 1600 },
  browserHeight: { min: 150, max: 900 },
} as const;

export const DEFAULT_LAYOUT: ShellLayoutPreferences = {
  mode: "code",
  railVisible: true,
  railWidth: 300,
  terminalWidth: 620,
  browserHeight: 232,
  openWorkspaceIds: ["lotus"],
  pinnedWorkspaceIds: [],
  tasksOpen: false,
  automationOpen: false,
  connectorsOpen: false,
  factoryOpen: false,
  factoryTab: "runs",
  automationNavWidth: 220,
  automationPaneWidth: 440,
  taskNavWidth: 260,
  taskNavVisible: true,
  taskHideDone: true,
  taskSort: "priority",
  ticketOrder: {},
  taskPrefixes: {},
  taskFilters: {},
  taskMe: null,
};

/** A stored id list, or the default: anything that is not a list of strings is not one. */
function readIds(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  return value.filter((id): id is string => typeof id === "string");
}

/** A stored prefix map, keeping only the entries that are actually a prefix. */
function readPrefixes(value: unknown, fallback: Record<string, string>): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0,
  );
  return Object.fromEntries(entries.map(([id, prefix]) => [id, prefix.trim().toUpperCase()]));
}

/** File → place, dropping anything that is not a finite number: a NaN would sort nowhere. */
function readPlaces(value: unknown, fallback: Record<string, number>): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
    ),
  );
}

/** View → rules, keeping only views that still hold a rule. */
function readViewFilters(value: unknown): Record<string, TaskFilterRule[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([view, rules]) => [view, readFilterRules(rules)] as const)
      .filter(([, rules]) => rules.length > 0),
  );
}

function readIdentity(value: unknown): FilterIdentity | null {
  if (!value || typeof value !== "object") return null;
  const { id, name } = value as Record<string, unknown>;
  return typeof id === "string" && id && typeof name === "string" ? { id, name } : null;
}

function readNumber(value: unknown, fallback: number, bounds: { min: number; max: number }): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clampSplitSize(value, bounds);
}

export function parseLayoutPreferences(raw: string | null): ShellLayoutPreferences {
  if (!raw) return DEFAULT_LAYOUT;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_LAYOUT;
  }

  if (!parsed || typeof parsed !== "object") return DEFAULT_LAYOUT;
  const value = parsed as Partial<Record<keyof ShellLayoutPreferences, unknown>>;

  return {
    mode: value.mode === "chat" ? "chat" : "code",
    railVisible: typeof value.railVisible === "boolean" ? value.railVisible : DEFAULT_LAYOUT.railVisible,
    railWidth: readNumber(value.railWidth, DEFAULT_LAYOUT.railWidth, LAYOUT_BOUNDS.railWidth),
    terminalWidth: readNumber(value.terminalWidth, DEFAULT_LAYOUT.terminalWidth, LAYOUT_BOUNDS.terminalWidth),
    browserHeight: readNumber(value.browserHeight, DEFAULT_LAYOUT.browserHeight, LAYOUT_BOUNDS.browserHeight),
    openWorkspaceIds: readIds(value.openWorkspaceIds, DEFAULT_LAYOUT.openWorkspaceIds),
    pinnedWorkspaceIds: readIds(value.pinnedWorkspaceIds, DEFAULT_LAYOUT.pinnedWorkspaceIds),
    tasksOpen: typeof value.tasksOpen === "boolean" ? value.tasksOpen : DEFAULT_LAYOUT.tasksOpen,
    automationOpen:
      typeof value.automationOpen === "boolean" ? value.automationOpen : DEFAULT_LAYOUT.automationOpen,
    connectorsOpen:
      typeof value.connectorsOpen === "boolean" ? value.connectorsOpen : DEFAULT_LAYOUT.connectorsOpen,
    factoryOpen: typeof value.factoryOpen === "boolean" ? value.factoryOpen : DEFAULT_LAYOUT.factoryOpen,
    factoryTab: isFactoryTab(value.factoryTab) ? value.factoryTab : DEFAULT_LAYOUT.factoryTab,
    automationNavWidth: readNumber(
      value.automationNavWidth,
      DEFAULT_LAYOUT.automationNavWidth,
      LAYOUT_BOUNDS.automationNavWidth,
    ),
    automationPaneWidth: readNumber(
      value.automationPaneWidth,
      DEFAULT_LAYOUT.automationPaneWidth,
      LAYOUT_BOUNDS.automationPaneWidth,
    ),
    taskNavWidth: readNumber(value.taskNavWidth, DEFAULT_LAYOUT.taskNavWidth, LAYOUT_BOUNDS.taskNavWidth),
    taskNavVisible:
      typeof value.taskNavVisible === "boolean" ? value.taskNavVisible : DEFAULT_LAYOUT.taskNavVisible,
    taskHideDone:
      typeof value.taskHideDone === "boolean" ? value.taskHideDone : DEFAULT_LAYOUT.taskHideDone,
    taskSort: TASK_SORTS.includes(value.taskSort as TaskSort)
      ? (value.taskSort as TaskSort)
      : DEFAULT_LAYOUT.taskSort,
    ticketOrder: readPlaces(value.ticketOrder, DEFAULT_LAYOUT.ticketOrder),
    taskPrefixes: readPrefixes(value.taskPrefixes, DEFAULT_LAYOUT.taskPrefixes),
    taskFilters: readViewFilters(value.taskFilters),
    taskMe: readIdentity(value.taskMe),
  };
}

export function serializeLayoutPreferences(preferences: ShellLayoutPreferences): string {
  return JSON.stringify(preferences);
}

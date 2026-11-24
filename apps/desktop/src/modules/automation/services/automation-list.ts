import type { Automation, AutomationRun } from "./automation-api";
import { describeCron } from "./format";

/** What starts an automation, as its row and header show it. */
export type TriggerKind = "schedule" | "slack" | "github" | "manual";

export function triggerOf(a: Automation): { kind: TriggerKind; label: string } {
  if (a.triggerKind === "schedule" && a.schedule) return { kind: "schedule", label: describeCron(a.schedule.cron) };
  if (a.triggerKind === "slack" && a.slack) {
    const n = a.slack.channels.length;
    return { kind: "slack", label: `Slack · ${n} channel${n === 1 ? "" : "s"}${a.github ? " · GitHub" : ""}` };
  }
  if (a.github) return { kind: "github", label: "GitHub review requests" };
  return { kind: "manual", label: "On demand" };
}

export type SortBy = "created" | "name" | "next";
export type ListView = {
  query?: string;
  /** Empty or absent: every status. */
  status?: ("on" | "off")[];
  triggers?: TriggerKind[];
  sort?: { by: SortBy; dir: "asc" | "desc" };
};

export const DEFAULT_SORT: NonNullable<ListView["sort"]> = { by: "created", dir: "desc" };

/**
 * Search, filter and sort, in that order. Automations that are on always come before those that
 * are off (bb groups by lifecycle before its sort, overview-view.tsx:190-201): an off row is the
 * one you are least likely to be looking for.
 */
export function applyListView(all: Automation[], view: ListView): Automation[] {
  const query = view.query?.trim().toLowerCase() ?? "";
  const { by, dir } = view.sort ?? DEFAULT_SORT;
  const compare = (a: Automation, b: Automation): number => {
    switch (by) {
      case "name":
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      case "next":
        return (a.nextRunMs ?? Number.MAX_SAFE_INTEGER) - (b.nextRunMs ?? Number.MAX_SAFE_INTEGER);
      default:
        return a.createdAtMs - b.createdAtMs;
    }
  };
  return all
    .filter((a) => !query || a.name.toLowerCase().includes(query))
    .filter((a) => !view.status?.length || view.status.includes(a.enabled ? "on" : "off"))
    .filter((a) => !view.triggers?.length || view.triggers.includes(triggerOf(a).kind))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (dir === "asc" ? 1 : -1) * compare(a, b));
}

/** The newest run of `a` in `runs` (which arrive newest first). */
export function lastRunOf(a: Automation, runs: AutomationRun[]): AutomationRun | null {
  return runs.filter((r) => r.automationId === a.id).sort((x, y) => y.createdAtMs - x.createdAtMs)[0] ?? null;
}

const DAY_MS = 86_400_000;
const SHORT_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** "in 20m", "today", "tomorrow", "in 4 days", else the date: when a next run is, said plainly. */
export function relativeDay(ms: number, now = Date.now()): string {
  const minutes = Math.round((ms - now) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  const startOf = (t: number) => new Date(new Date(t).toDateString()).getTime();
  const days = Math.round((startOf(ms) - startOf(now)) / DAY_MS);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 7) return `in ${days} days`;
  return SHORT_DAY.format(new Date(ms));
}

/**
 * The one line under an automation's name in the Dock (`.pen` 16c v2): what it does next, or why it
 * will not. A pause after failures is the one thing said in red.
 */
export function rowNext(
  a: Automation,
  { lastRun, channelName, now = Date.now() }: { lastRun: AutomationRun | null; channelName?: (id: string) => string | undefined; now?: number },
): { tone: "plain" | "busy" | "error"; text: string } {
  const failed = lastRun?.status === "failed" || lastRun?.status === "interrupted";
  if (!a.enabled && failed) return { tone: "error", text: `Paused after failures${lastRun?.advice ?? lastRun?.detail ? ` · ${lastRun?.advice ?? lastRun?.detail}` : ""}` };
  if (lastRun?.status === "running" || lastRun?.status === "queued") return { tone: "busy", text: "Running now" };
  if (a.triggerKind === "schedule" && a.schedule) {
    const cadence = describeCron(a.schedule.cron);
    return { tone: "plain", text: a.enabled && a.nextRunMs ? `${cadence} · ${relativeDay(a.nextRunMs, now)}` : cadence };
  }
  if (a.triggerKind === "slack" && a.slack?.channels.length) {
    const [first, ...rest] = a.slack.channels;
    const name = `#${(channelName?.(first) ?? first).replace(/^#/, "")}`;
    return { tone: "plain", text: `When someone asks in ${name}${rest.length ? ` +${rest.length}` : ""}` };
  }
  if (a.github) return { tone: "plain", text: "When GitHub asks you to review" };
  return { tone: "plain", text: "Only when you start it" };
}

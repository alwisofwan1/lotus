import { describe, expect, it } from "vitest";

import { applyListView, lastRunOf, relativeDay, rowNext, triggerOf } from "../automation-list";
import type { Automation, AutomationRun } from "../automation-api";

function automation(over: Partial<Automation>): Automation {
  return {
    id: "a",
    name: "A",
    enabled: true,
    triggerKind: "manual",
    actionKind: "pr_review",
    config: null,
    slack: null,
    github: null,
    schedule: null,
    prompt: null,
    createdAtMs: 1,
    nextRunMs: null,
    ...over,
  };
}

const brief = automation({
  id: "brief",
  name: "Morning brief",
  triggerKind: "schedule",
  actionKind: "agent_prompt",
  schedule: { cron: "0 9 * * 1,2,3,4,5", timezone: "Asia/Jakarta" },
  createdAtMs: 3,
  nextRunMs: 500,
});
const reviews = automation({
  id: "reviews",
  name: "Orbit reviews",
  triggerKind: "slack",
  slack: { channels: ["C1", "C2"], team: "S1" },
  createdAtMs: 2,
});
const onDemand = automation({ id: "adhoc", name: "Ad-hoc review", enabled: false, createdAtMs: 1 });

describe("triggerOf", () => {
  it("names what starts each kind of automation", () => {
    expect(triggerOf(brief)).toEqual({ kind: "schedule", label: "9AM Mon-Fri" });
    expect(triggerOf(reviews)).toEqual({ kind: "slack", label: "Slack · 2 channels" });
    expect(triggerOf(onDemand)).toEqual({ kind: "manual", label: "On demand" });
  });

  it("names GitHub when a review watches its review requests, alone or beside Slack", () => {
    expect(triggerOf({ ...onDemand, github: { team: null } })).toEqual({ kind: "github", label: "GitHub review requests" });
    expect(triggerOf({ ...reviews, github: { team: "o/t" } })).toEqual({ kind: "slack", label: "Slack · 2 channels · GitHub" });
  });
});

describe("applyListView", () => {
  const all = [onDemand, brief, reviews];

  it("searches the name, case-insensitively", () => {
    expect(applyListView(all, { query: "REVIEW" }).map((a) => a.id)).toEqual(["reviews", "adhoc"]);
  });

  it("filters by status and by trigger", () => {
    expect(applyListView(all, { status: ["off"] }).map((a) => a.id)).toEqual(["adhoc"]);
    expect(applyListView(all, { triggers: ["schedule", "slack"] }).map((a) => a.id)).toEqual(["brief", "reviews"]);
  });

  it("puts what is on first, then sorts; picking the same sort twice flips it", () => {
    expect(applyListView(all, { sort: { by: "name", dir: "asc" } }).map((a) => a.id)).toEqual([
      "brief",
      "reviews",
      "adhoc",
    ]);
    expect(applyListView(all, { sort: { by: "name", dir: "desc" } }).map((a) => a.id)).toEqual([
      "reviews",
      "brief",
      "adhoc",
    ]);
    expect(applyListView(all, { sort: { by: "created", dir: "desc" } }).map((a) => a.id)).toEqual([
      "brief",
      "reviews",
      "adhoc",
    ]);
  });
});

describe("lastRunOf", () => {
  it("is the newest run of that automation", () => {
    const run = (id: string, automationId: string, createdAtMs: number): AutomationRun => ({
      id,
      automationId,
      automationName: "",
      key: id,
      status: "succeeded",
      detail: null,
      createdAtMs,
      finishedAtMs: createdAtMs + 1,
    });
    const runs = [run("r3", "brief", 30), run("r2", "reviews", 20), run("r1", "brief", 10)];
    expect(lastRunOf(brief, runs)?.id).toBe("r3");
    expect(lastRunOf(onDemand, runs)).toBeNull();
  });
});

describe("rowNext — the line under a name in the Dock (16c v2)", () => {
  const now = new Date(2026, 9, 16, 10, 0).getTime();
  it("says when a schedule runs next, in plain days", () => {
    const next = new Date(2026, 9, 17, 9, 0).getTime();
    expect(rowNext({ ...brief, nextRunMs: next }, { lastRun: null, now }).text).toMatch(/ · tomorrow$/);
    expect(relativeDay(now + 20 * 60_000, now)).toBe("in 20m");
    expect(relativeDay(new Date(2026, 9, 20, 9).getTime(), now)).toBe("in 4 days");
  });
  it("names the Slack channel it listens in", () => {
    expect(rowNext(reviews, { lastRun: null, channelName: (id) => (id === "C1" ? "eng" : undefined) }).text).toBe("When someone asks in #eng +1");
  });
  it("says a pause after failures in red, with why", () => {
    const failed = { status: "failed", detail: "runner timed out" } as AutomationRun;
    expect(rowNext(onDemand, { lastRun: failed })).toEqual({ tone: "error", text: "Paused after failures · runner timed out" });
    expect(rowNext(onDemand, { lastRun: null }).text).toBe("Only when you start it");
  });
});

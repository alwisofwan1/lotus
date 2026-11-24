import { describe, expect, it } from "vitest";
import { describeHealth, type SourceHealth } from "@/modules/tasks/services/source-health";

// The words are SOURCES 06's (mockups/lotus-agent.pen): one state, the same words in the nav row,
// the list banner and Connectors.

const NOW = new Date(2026, 8, 29, 13, 42, 0).getTime();
const SYNCED = new Date(2026, 8, 29, 13, 40, 0).getTime();

function view(health: SourceHealth | null, extra: { syncing?: boolean; syncedAtMs?: number | null } = {}) {
  return describeHealth({
    label: "Notion",
    name: "Orbit board",
    health,
    syncing: extra.syncing ?? false,
    syncedAtMs: extra.syncedAtMs === undefined ? SYNCED : extra.syncedAtMs,
    nowMs: NOW,
  });
}

describe("a ticket source's health, in words", () => {
  it("healthy: says when it last synced, and has no banner", () => {
    expect(view({ state: "healthy" })).toEqual({ state: "healthy", tone: "ok", line: "Notion · synced 2 min ago", banner: null, action: null });
    expect(view({ state: "healthy" }, { syncedAtMs: NOW - 10_000 }).line).toBe("Notion · synced just now");
  });

  it("syncing: rows stay, and only the line changes", () => {
    expect(view({ state: "healthy" }, { syncing: true })).toMatchObject({ state: "syncing", tone: "busy", line: "Notion · syncing…", banner: null });
    expect(view(null, { syncing: true, syncedAtMs: null }).line).toBe("Notion · syncing…");
  });

  it("offline: shows the time of the copy on screen, and offers Retry", () => {
    expect(view({ state: "offline", message: "Notion could not be reached" })).toEqual({
      state: "offline",
      tone: "warn",
      line: "Notion · offline, showing 13:40",
      banner: "You are offline. Showing tickets as of 13:40.",
      action: "retry",
    });
  });

  it("slowed down: counts down to the retry, and needs no action", () => {
    expect(view({ state: "slowed_down", retryAtMs: NOW + 30_000 })).toEqual({
      state: "slowed_down",
      tone: "warn",
      line: "Notion · slowed down, retrying",
      banner: "Notion asked Lotus to slow down. Retrying in 30 s — nothing is lost.",
      action: null,
    });
    expect(view({ state: "slowed_down", retryAtMs: NOW + 150_000 }).banner).toContain("Retrying in 3 min");
  });

  it("lost access: names the database, and asks for what fixes it", () => {
    const unshared = view({ state: "lost_access", why: "unshared" });
    expect(unshared).toMatchObject({ state: "lost_access", tone: "bad", line: "Notion · no access", action: "how_to_share" });
    expect(unshared.banner).toBe("Lotus can no longer see Orbit board. It was unshared or moved to trash.");
    const token = view({ state: "lost_access", why: "token" });
    expect(token).toMatchObject({ line: "Notion · no access", action: "reconnect" });
    expect(token.banner).toBe("Lotus can no longer see Orbit board. The Notion token was revoked or has expired.");
  });

  it("a problem stays said while the next sync runs, so the banner does not flicker", () => {
    expect(view({ state: "offline", message: "x" }, { syncing: true }).state).toBe("offline");
  });

  it("any other refusal says what Notion said, and offers Retry", () => {
    expect(view({ state: "failed", message: "read the database's tickets: Notion said validation_error: bad filter" })).toEqual({
      state: "failed",
      tone: "bad",
      line: "Notion · could not sync",
      banner: "Notion could not be read (read the database's tickets: Notion said validation_error: bad filter). Showing tickets as of 13:40.",
      action: "retry",
    });
  });

  it("fields changed: names the field, keeps the tickets, pauses changes, and offers Remap fields", () => {
    expect(view({ state: "fields_changed", fields: [{ field: "status", nowKind: null }] })).toEqual({
      state: "fields_changed",
      tone: "warn",
      line: "Notion · 1 field needs you",
      banner: "The Status field was removed or changed type in Notion. Tickets still show; changes are paused until you remap it.",
      action: "remap",
    });
    const two = view({ state: "fields_changed", fields: [{ field: "status", nowKind: "select" }, { field: "assignee", nowKind: null }] });
    expect(two.line).toBe("Notion · 2 fields need you");
    expect(two.banner).toBe(
      "The Status and Assignee fields were removed or changed type in Notion. Tickets still show; changes are paused until you remap them.",
    );
  });

  it("before anything was read, says so", () => {
    expect(view(null, { syncedAtMs: null }).line).toBe("Notion · reading…");
  });
});

describe("a GitHub source's health (ADR-0048 §9)", () => {
  const github = (health: SourceHealth) =>
    describeHealth({ label: "GitHub", name: "initech/lotus", health, syncing: false, syncedAtMs: SYNCED, nowMs: NOW });

  it("lost access says which of three things is wrong, and offers Retry — the fix is outside Lotus", () => {
    const login = github({ state: "lost_access", why: "login" });
    expect(login).toMatchObject({ line: "GitHub · no access", tone: "bad", action: "retry" });
    expect(login.banner).toBe(
      "Lotus can no longer see initech/lotus. Its GitHub account is not signed in to gh. Run gh auth login in a terminal, then Retry.",
    );
    expect(github({ state: "lost_access", why: "access" }).banner).toBe(
      "Lotus can no longer see initech/lotus. Its GitHub account may no longer read this repo.",
    );
    expect(github({ state: "lost_access", why: "repo" }).banner).toBe(
      "Lotus can no longer see initech/lotus. The repo was deleted, renamed or made private, or its issues were turned off.",
    );
  });

  it("slowed down and offline use the same words as Notion", () => {
    expect(github({ state: "slowed_down", retryAtMs: NOW + 30_000 }).banner).toBe(
      "GitHub asked Lotus to slow down. Retrying in 30 s — nothing is lost.",
    );
    expect(github({ state: "offline", message: "dial tcp" }).line).toBe("GitHub · offline, showing 13:40");
  });
});

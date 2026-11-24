import { describe, expect, it } from "vitest";
import type { TrackerProject, TrackerTask } from "@/modules/tasks/types";
import {
  notesByKey,
  readTicketPlace,
  ticketSourceKindOfTask,
  writeTicketPlaces,
} from "@/modules/tasks/services/ticket-sources";

describe("a ticket source's manual order", () => {
  it("reads a place kept under the source's own key", () => {
    expect(readTicketPlace({ "vault:TKT-1.md": 2 }, "vault", "TKT-1.md", true)).toBe(2);
  });

  it("reads a bare key as the Obsidian source's, because only it ever wrote one", () => {
    expect(readTicketPlace({ "TKT-1.md": 2 }, "vault", "TKT-1.md", true)).toBe(2);
    // Any other source must not pick up the vault's old places.
    expect(readTicketPlace({ "TKT-1.md": 2 }, "notion-1", "TKT-1.md", false)).toBeUndefined();
  });

  it("prefers the source's key over a bare one left from before", () => {
    expect(readTicketPlace({ "TKT-1.md": 2, "vault:TKT-1.md": 5 }, "vault", "TKT-1.md", true)).toBe(5);
  });

  it("writes under the source's key, moves legacy places over, and drops rows the source no longer holds", () => {
    const next = writeTicketPlaces(
      { "TKT-2.md": 1, "gone.md": 7, "vault:old.md": 3 },
      "vault",
      new Set(["TKT-1.md", "TKT-2.md"]),
      [{ id: "TKT-1.md", position: 4 }],
      true,
    );
    expect(next).toEqual({ "vault:TKT-1.md": 4, "vault:TKT-2.md": 1 });
  });

  it("leaves every other source's places alone", () => {
    const next = writeTicketPlaces(
      { "notion-1:page-a": 1, "vault:TKT-1.md": 2 },
      "vault",
      new Set(["TKT-1.md"]),
      [{ id: "TKT-1.md", position: 9 }],
      true,
    );
    expect(next).toEqual({ "notion-1:page-a": 1, "vault:TKT-1.md": 9 });
  });

  it("keeps the vault's bare keys when a different source is reordered", () => {
    const next = writeTicketPlaces(
      { "TKT-1.md": 2 },
      "notion-1",
      new Set(["page-a"]),
      [{ id: "page-a", position: 1 }],
      false,
    );
    expect(next).toEqual({ "TKT-1.md": 2, "notion-1:page-a": 1 });
  });
});

describe("where a stored task's backlink points", () => {
  it("reads the word tasks on disk already carry as the Obsidian source", () => {
    expect(ticketSourceKindOfTask("vault")).toBe("obsidian");
    expect(ticketSourceKindOfTask("notion")).toBe("notion");
  });
});

describe("notes matched by key (PLAN S37)", () => {
  const notion = (matchesNotes: boolean) => ({ source: { kind: "notion" as const, syncLine: "", matchesNotes } });
  const vault = { source: { kind: "obsidian" as const, syncLine: "" } };
  const row = (id: string, projectId: string, key?: string): TrackerTask => ({
    id, projectId, ...(key ? { key } : {}), title: id, status: "todo", priority: "none", createdAt: 0, updatedAt: 0,
  });
  const projects = (matches: boolean, withVault = true) =>
    new Map<string, Pick<TrackerProject, "source">>([
      ["notion-1", notion(matches)],
      ...(withVault ? ([["vault", vault]] as const) : []),
    ]);

  it("matches Notion ticket TKT-1008 with the vault's TKT-1008.md", () => {
    const tasks = [row("page-a", "notion-1", "TKT-1008"), row("TKT-1008.md", "vault", "TKT-1008")];
    expect(notesByKey(tasks, projects(true))).toEqual(new Map([["page-a", "TKT-1008.md"]]));
  });

  it("gives a ticket with no note of its key nothing", () => {
    const tasks = [row("page-a", "notion-1", "TKT-1008"), row("TKT-1009.md", "vault", "TKT-1009")];
    expect(notesByKey(tasks, projects(true)).size).toBe(0);
  });

  it("matches a note in a folder, and a key written in another case", () => {
    const tasks = [row("page-a", "notion-1", "tkt-1008"), row("tickets/TKT-1008.md", "vault")];
    expect(notesByKey(tasks, projects(true)).get("page-a")).toBe("tickets/TKT-1008.md");
  });

  it("falls back to the key a note declares, and prefers the note named after the key", () => {
    const declared = [row("page-a", "notion-1", "TKT-1008"), row("webhook.md", "vault", "TKT-1008")];
    expect(notesByKey(declared, projects(true)).get("page-a")).toBe("webhook.md");
    const both = [...declared, row("TKT-1008.md", "vault")];
    expect(notesByKey(both, projects(true)).get("page-a")).toBe("TKT-1008.md");
  });

  it("matches nothing when the option is off, or when there is no vault", () => {
    const tasks = [row("page-a", "notion-1", "TKT-1008"), row("TKT-1008.md", "vault", "TKT-1008")];
    expect(notesByKey(tasks, projects(false)).size).toBe(0);
    expect(notesByKey(tasks.slice(0, 1), projects(true, false)).size).toBe(0);
  });

  it("never matches a vault note with itself, nor a workspace task", () => {
    const tasks = [row("TKT-1008.md", "vault", "TKT-1008"), row("t1", "w1", "TKT-1008")];
    expect(notesByKey(tasks, projects(true)).size).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import type { CanvasSessionRecord, CanvasSessionStatus } from "../session-record";
import {
  filterSessions,
  groupSessionsByTime,
  sessionsForProjectList,
  sessionPreviewLine,
  relativeAge,
  sessionMetaLine,
  sessionRowTitle,
} from "../session-view";

// Local time, so the day bands are the same in every timezone the suite runs in.
const NOW = new Date(2026, 10, 13, 15, 0).getTime();
const HOUR = 3_600_000;

function session(
  overrides: Partial<CanvasSessionRecord> & { id: string; status?: CanvasSessionStatus },
): CanvasSessionRecord {
  return {
    projectId: "cp_1",
    nodeId: `node-${overrides.id}`,
    runner: "claude",
    cwd: "/tmp/demo",
    title: `Session ${overrides.id}`,
    status: "resumable",
    origin: "manual",
    turnCount: 0,
    lastActivityAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

describe("groupSessionsByTime", () => {
  it("puts running sessions first, then the rest by calendar day, newest first in each", () => {
    const groups = groupSessionsByTime(
      [
        session({ id: "today-old", lastActivityAt: NOW - 10 * HOUR }),
        session({ id: "live", status: "live", lastActivityAt: NOW - 3 * 24 * HOUR }),
        session({ id: "today-new", lastActivityAt: NOW - HOUR }),
        session({ id: "yesterday", lastActivityAt: NOW - 20 * HOUR }),
        session({ id: "earlier", lastActivityAt: NOW - 3 * 24 * HOUR }),
      ],
      NOW,
    );
    expect(groups.map((g) => [g.label, g.sessions.map((s) => s.id)])).toEqual([
      ["Running", ["live"]],
      ["Today", ["today-new", "today-old"]],
      ["Yesterday", ["yesterday"]],
      ["Earlier", ["earlier"]],
    ]);
  });

  it("omits a band that has nothing in it", () => {
    expect(groupSessionsByTime([session({ id: "a" })], NOW).map((g) => g.key)).toEqual(["today"]);
    expect(groupSessionsByTime([], NOW)).toEqual([]);
  });

  // A row with no node cannot be running, whatever its status says.
  it("never counts a detached row as running", () => {
    const groups = groupSessionsByTime([session({ id: "orphan", nodeId: null, status: "live" })], NOW);
    expect(groups.map((g) => g.key)).toEqual(["today"]);
  });
});

describe("sessionMetaLine", () => {
  it("reads agent, runner and age", () => {
    const line = sessionMetaLine(
      session({ id: "a", runner: "codex", lastActivityAt: NOW - 3 * HOUR }),
      NOW,
      "Rowan",
    );
    expect(line).toBe("Rowan · codex · 3h");
  });

  it("says when a conversation has no node to open on", () => {
    expect(sessionMetaLine(session({ id: "a", nodeId: null }), NOW)).toBe("claude · now · No node");
  });
});

describe("relativeAge", () => {
  it("scales from minutes to days", () => {
    expect(relativeAge(NOW, NOW)).toBe("now");
    expect(relativeAge(NOW - 5 * 60_000, NOW)).toBe("5m");
    expect(relativeAge(NOW - 2 * HOUR, NOW)).toBe("2h");
    expect(relativeAge(NOW - 26 * HOUR, NOW)).toBe("yesterday");
    expect(relativeAge(NOW - 3 * 24 * HOUR, NOW)).toBe("3d");
  });

  it("never reads as the future when a clock skews", () => {
    expect(relativeAge(NOW + 60_000, NOW)).toBe("now");
  });
});

describe("sessionRowTitle", () => {
  it("prefixes the agent handle when asked to", () => {
    expect(sessionRowTitle(session({ id: "a", title: "Transcript route" }), "Rowan")).toBe(
      "Rowan · Transcript route",
    );
  });

  it("names a placeholder-titled row by what it was asked", () => {
    for (const title of ["Rowan · sesi baru", "Rowan · new conversation"]) {
      expect(sessionRowTitle(session({ id: "a", title, lastPrompt: "fix the redirect" }))).toBe(
        "fix the redirect",
      );
    }
  });

  it("falls back when a session has no title and nothing was asked", () => {
    expect(sessionRowTitle(session({ id: "a", title: "   " }))).toBe("New conversation");
  });
});

describe("provenance (Slice 10)", () => {
  // One graph run of five agents would otherwise push five days of real conversations out of view.
  it("keeps machine-started conversations out of the project list", () => {
    const rows = sessionsForProjectList([
      session({ id: "mine" }),
      session({ id: "run-1", origin: "graph-run", graphRunId: "gr-1" }),
    ]);
    expect(rows.map((s) => s.id)).toEqual(["mine"]);
  });

  // A teammate's spawn is a real conversation; only its trigger differed.
  it("keeps sessions an agent started via MCP", () => {
    expect(sessionsForProjectList([session({ id: "peer", origin: "mcp" })])).toHaveLength(1);
  });
});

describe("sessionPreviewLine", () => {
  it("shows what the conversation was last asked, on one line", () => {
    expect(sessionPreviewLine(session({ id: "a", lastPrompt: "perbaiki  resume\nyang putus" }))).toBe(
      "perbaiki resume yang putus",
    );
  });

  it("is empty for a row that has never been spoken to", () => {
    expect(sessionPreviewLine(session({ id: "a" }))).toBeNull();
  });
});

describe("filterSessions", () => {
  const rows = [
    session({ id: "a", title: "perbaiki resume", lastPrompt: "resume putus di tengah" }),
    session({ id: "b", title: "tulis tes panel", lastPrompt: "tambahkan vitest", runner: "codex" }),
  ];

  it("returns everything for an empty query", () => {
    expect(filterSessions(rows, "  ")).toHaveLength(2);
  });

  it("matches the title regardless of case", () => {
    expect(filterSessions(rows, "RESUME").map((s) => s.id)).toEqual(["a"]);
  });

  it("matches a phrase from inside the conversation, not only its name", () => {
    expect(filterSessions(rows, "vitest").map((s) => s.id)).toEqual(["b"]);
  });

  it("matches the runner", () => {
    expect(filterSessions(rows, "codex").map((s) => s.id)).toEqual(["b"]);
  });
});

describe("sessionPreviewLine — escape residue", () => {
  it("shows nothing rather than a leaked mouse report", () => {
    expect(sessionPreviewLine(session({ id: "a", lastPrompt: "<0;50;20M<0;50;20m" }))).toBeNull();
  });
});

describe("sessionRowTitle — a residue title is never shown", () => {
  it("falls back to what the conversation was last asked", () => {
    const row = session({
      id: "a",
      title: "<0;50;20M<0;50;20m<0;4…",
      lastPrompt: "buatkan pantun",
    });
    expect(sessionRowTitle(row, "Ivo")).toBe("Ivo · buatkan pantun");
  });

  it("falls back to a generic title when there is nothing to fall back to", () => {
    expect(sessionRowTitle(session({ id: "a", title: "<0;50;20M<0;50;20m<0;4…" }))).toBe(
      "New conversation",
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  hasGitHubRepo,
  isGitHubRepoName,
  OBSIDIAN_SOURCE_ID,
  resolveTicketSources,
  withGitHubSource,
  withNotionSource,
  withObsidianSource,
  withoutSource,
} from "@/modules/tasks/services/ticket-source-settings";
import type { ClaudeSettings } from "@/modules/settings/types";

const settings = (value: Record<string, unknown>) => value as unknown as ClaudeSettings;

describe("reading ticket sources out of settings", () => {
  it("reads a file from before sources existed — only vault.path — as one Obsidian source", () => {
    expect(resolveTicketSources(settings({ vault: { path: "/Users/a/orbit-vault" } }))).toEqual([
      { id: OBSIDIAN_SOURCE_ID, kind: "obsidian", path: "/Users/a/orbit-vault" },
    ]);
  });

  it("reads no ticketSources and no vault path as no sources, not an error", () => {
    expect(resolveTicketSources(undefined)).toEqual([]);
    expect(resolveTicketSources(null)).toEqual([]);
    expect(resolveTicketSources(settings({}))).toEqual([]);
    expect(resolveTicketSources(settings({ ticketSources: "not a list", vault: { path: "  " } }))).toEqual([]);
  });

  it("drops a listed vault whose path an older build cleared", () => {
    // An older Lotus disconnects by writing vault.path = "" and leaves ticketSources alone.
    expect(
      resolveTicketSources(settings({ ticketSources: [{ id: "vault", kind: "obsidian" }], vault: { path: "" } })),
    ).toEqual([]);
  });

  it("follows vault.path when an older build pointed it somewhere else", () => {
    expect(
      resolveTicketSources(
        settings({ ticketSources: [{ id: "vault", kind: "obsidian" }], vault: { path: "/Users/a/other" } }),
      ),
    ).toEqual([{ id: OBSIDIAN_SOURCE_ID, kind: "obsidian", path: "/Users/a/other" }]);
  });

  it("shows at most one vault, and leaves out kinds this build cannot read", () => {
    expect(
      resolveTicketSources(
        settings({
          ticketSources: [{ id: "n1", kind: "notion" }, { kind: "obsidian" }, { kind: "obsidian" }, 7, null],
          vault: { path: "/v" },
        }),
      ),
    ).toEqual([{ id: OBSIDIAN_SOURCE_ID, kind: "obsidian", path: "/v" }]);
  });
});

describe("writing the Obsidian source", () => {
  it("adds it to the list and keeps vault.path for older builds", () => {
    const next = withObsidianSource(settings({ env: { A: "1" } }), "/Users/a/vault");
    expect(next).toEqual({
      env: { A: "1" },
      ticketSources: [{ id: "vault", kind: "obsidian" }],
      vault: { path: "/Users/a/vault" },
    });
  });

  it("removes it from the list and clears vault.path, as disconnecting always did", () => {
    const next = withObsidianSource(
      settings({ ticketSources: [{ id: "vault", kind: "obsidian" }], vault: { path: "/v" } }),
      null,
    );
    expect(next).toMatchObject({ ticketSources: [], vault: { path: "" } });
    expect(resolveTicketSources(next)).toEqual([]);
  });

  it("keeps entries of kinds it does not know, in their place", () => {
    const notion = { id: "n1", kind: "notion", databaseId: "abc" };
    const next = withObsidianSource(
      settings({ ticketSources: [notion, { id: "vault", kind: "obsidian" }], vault: { path: "/old" } }),
      "/new",
    );
    expect(next).toMatchObject({
      ticketSources: [notion, { id: "vault", kind: "obsidian" }],
      vault: { path: "/new" },
    });
    expect(withObsidianSource(next, null)).toMatchObject({ ticketSources: [notion] });
  });

  it("round-trips: what was written reads back as the same source", () => {
    const written = withObsidianSource(settings({}), "  /Users/a/vault  ");
    expect(resolveTicketSources(written)).toEqual([
      { id: OBSIDIAN_SOURCE_ID, kind: "obsidian", path: "/Users/a/vault" },
    ]);
  });
});

describe("Notion sources in settings", () => {
  const notion = {
    id: "notion-248104cd",
    kind: "notion" as const,
    name: "Orbit board",
    dataSourceId: "248104cd-477e-80af-bc30-000bea2dd2a5",
    url: "https://www.notion.so/x",
    mapping: { title: "title", key: "id", status: "st", assignee: null, labels: null, parent: null },
    statuses: { options: [{ id: "st1", name: "Todo", color: null }], groups: [{ id: "g", name: "To-do", optionIds: ["st1"] }] },
    permission: "read_only" as const,
  };

  it("is written whole into the list and read back as the same source", () => {
    // A vault from an older file has no list entry yet, so it follows the listed sources.
    const written = withNotionSource(settings({ vault: { path: "/v" } }), notion);
    expect(resolveTicketSources(written)).toEqual([
      notion,
      { id: OBSIDIAN_SOURCE_ID, kind: "obsidian", path: "/v" },
    ]);
  });

  it("replaces the same database instead of adding it twice", () => {
    const once = withNotionSource(settings({}), notion);
    const twice = withNotionSource(once, { ...notion, name: "Renamed" });
    expect(resolveTicketSources(twice)).toEqual([{ ...notion, name: "Renamed" }]);
  });

  it("is removed by id, leaving the vault and every other entry alone", () => {
    const both = withNotionSource(withObsidianSource(settings({}), "/v"), notion);
    const next = withoutSource(both, notion.id);
    expect(resolveTicketSources(next)).toEqual([{ id: OBSIDIAN_SOURCE_ID, kind: "obsidian", path: "/v" }]);
  });

  it("survives the vault being connected and disconnected", () => {
    const withBoth = withObsidianSource(withNotionSource(settings({}), notion), "/v");
    expect(resolveTicketSources(withObsidianSource(withBoth, null))).toEqual([notion]);
  });

  it("drops a hand-edited entry that has no database, or an id that could not be a file name", () => {
    expect(
      resolveTicketSources(
        settings({ ticketSources: [{ id: "x", kind: "notion" }, { ...notion, id: "../evil" }] }),
      ),
    ).toEqual([]);
  });

  it("keeps \"Match notes by key\" only when it is exactly on", () => {
    expect(resolveTicketSources(settings({ ticketSources: [{ ...notion, matchNotes: true }] }))[0]).toMatchObject({ matchNotes: true });
    expect(resolveTicketSources(settings({ ticketSources: [{ ...notion, matchNotes: "yes" }] }))[0]).not.toHaveProperty("matchNotes");
    expect(resolveTicketSources(settings({ ticketSources: [notion] }))[0]).not.toHaveProperty("matchNotes");
  });

  it("reads an unknown permission as read only", () => {
    const read = resolveTicketSources(settings({ ticketSources: [{ ...notion, permission: "everything" }] }));
    expect(read[0]).toMatchObject({ permission: "read_only" });
  });
});

describe("GitHub sources in settings (ADR-0048, PLAN G16)", () => {
  const github = { id: "github-initech-lotus", kind: "github", account: "alwisofwan1", repo: "initech/lotus", name: "Lotus" };

  it("reads a hand-written entry as a source, after the vault and Notion in list order", () => {
    expect(resolveTicketSources(settings({ ticketSources: [github], vault: { path: "/v" } }))).toEqual([
      { id: "github-initech-lotus", kind: "github", account: "alwisofwan1", repo: "initech/lotus", name: "Lotus" },
      { id: OBSIDIAN_SOURCE_ID, kind: "obsidian", path: "/v" },
    ]);
  });

  it("names a source after its repo when it has no name", () => {
    const [source] = resolveTicketSources(settings({ ticketSources: [{ ...github, name: " " }] }));
    expect(source).toMatchObject({ name: "initech/lotus" });
  });

  it("ignores entries that could never sync: no account, a bad account, a repo that is not owner/name", () => {
    const bad = [
      { ...github, id: "a", account: undefined },
      { ...github, id: "b", account: "-dash" },
      { ...github, id: "c", account: "a b" },
      { ...github, id: "d", repo: "lotus" },
      { ...github, id: "e", repo: "initech/lotus/x" },
      { ...github, id: "f", repo: "initech/.." },
      { ...github, id: "g", repo: "initech/lo tus" },
      { ...github, id: "../etc" },
    ];
    expect(resolveTicketSources(settings({ ticketSources: bad }))).toEqual([]);
  });

  it("shows one repo once, whatever the case (PLAN G2)", () => {
    const twice = [github, { ...github, id: "github-other", repo: "Initech/Lotus" }];
    expect(resolveTicketSources(settings({ ticketSources: twice })).map((s) => s.id)).toEqual(["github-initech-lotus"]);
  });

  it("is kept in place when the vault is connected", () => {
    const next = withObsidianSource(settings({ ticketSources: [github] }), "/v");
    expect((next as unknown as { ticketSources: unknown[] }).ticketSources).toContainEqual(github);
  });
});

describe("writing GitHub sources", () => {
  const repo = { id: "github-initech-lotus", kind: "github" as const, account: "alwisofwan1", repo: "initech/lotus", name: "initech/lotus" };

  it("adds a repo at the end and keeps every other key and entry", () => {
    const before = settings({ model: "opus", vault: { path: "/v" }, ticketSources: [{ id: "vault", kind: "obsidian" }, { id: "x", kind: "linear" }] });
    const written = withGitHubSource(before, repo) as unknown as Record<string, unknown>;
    expect(written.model).toBe("opus");
    expect(written.ticketSources).toEqual([{ id: "vault", kind: "obsidian" }, { id: "x", kind: "linear" }, repo]);
    expect(resolveTicketSources(written as unknown as ClaudeSettings).map((s) => s.id)).toEqual(["vault", "github-initech-lotus"]);
  });

  it("refuses the same repo twice, in any letter case, and removes it by id", () => {
    const once = withGitHubSource(settings({}), repo);
    const twice = withGitHubSource(once, { ...repo, id: "github-Initech-Lotus", repo: "Initech/Lotus", account: "other" });
    expect(twice).toBe(once);
    expect(hasGitHubRepo(once, "INITECH/lotus")).toBe(true);
    expect(hasGitHubRepo(withoutSource(once, repo.id), "initech/lotus")).toBe(false);
  });

  it("knows a typed owner/name from anything else", () => {
    expect(isGitHubRepoName("cli/cli")).toBe(true);
    expect(isGitHubRepoName("cli")).toBe(false);
    expect(isGitHubRepoName("cli/..")).toBe(false);
    expect(isGitHubRepoName("cli/cli; rm")).toBe(false);
  });
});

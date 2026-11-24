import { describe, expect, it } from "vitest";

import type { ThreadEvent, ThreadEventEnvelope } from "../thread-event";
import { applyThreadEvents, emptyThreadState } from "../thread-state";
import { buildTimelineRows, displayPath, lastLine, GAP_MS, gapDuration, sameTimelineRow, shownText, stepTitle, summarizeSteps, toolParts, type WorkStep } from "../timeline";

function envelopes(events: ThreadEvent[]): ThreadEventEnvelope[] {
  return events.map((event, i) => ({ threadId: "t", seq: i + 1, at: 1000 + i, event }));
}

const stateOf = (events: ThreadEvent[]) => applyThreadEvents(emptyThreadState("t"), envelopes(events));

describe("thread state", () => {
  it("appends text deltas to the running message", () => {
    const state = stateOf([
      { type: "turn/started", turnId: "u1", input: null },
      { type: "item/started", turnId: "u1", item: { id: "a", kind: "agentMessage", status: "running", text: "" } },
      { type: "item/delta", turnId: "u1", itemId: "a", delta: "Hel" },
      { type: "item/delta", turnId: "u1", itemId: "a", delta: "lo" },
    ]);
    expect(state.turns[0].items[0].item).toMatchObject({ text: "Hello", status: "running" });
    expect(buildTimelineRows(state)).toEqual([
      { kind: "assistant", id: "a", turnId: "u1", text: "Hello", streaming: true },
    ]);
  });

  it("ignores events from another thread and old seq numbers", () => {
    const state = stateOf([{ type: "turn/started", turnId: "u1", input: null }]);
    expect(applyThreadEvents(state, envelopes([{ type: "turn/started", turnId: "u2", input: null }]))).toBe(state);
    const other = { threadId: "x", seq: 9, at: 0, event: { type: "turn/started", turnId: "u3", input: null } } as const;
    expect(applyThreadEvents(state, [other])).toBe(state);
  });
});

describe("editing a sent message", () => {
  const input = (text: string) => ({ text, clientRequestId: text, attachments: [] });
  const turn = (id: string, text: string, forkPoint: string | null = `p-${id}`): ThreadEvent[] => [
    { type: "turn/started", turnId: id, input: input(text) },
    { type: "item/completed", turnId: id, item: { id: `${id}-a`, kind: "agentMessage", status: "completed", text: `re ${text}` } },
    { type: "turn/completed", turnId: id, status: "completed", error: null, usage: null, forkPoint },
  ];
  const users = (events: ThreadEvent[]) =>
    buildTimelineRows(stateOf(events)).flatMap((r) => (r.kind === "user" ? [[r.text, r.edit]] : []));

  it("can edit a message whose turn before left a fork point, and says why not otherwise", () => {
    expect(users([...turn("t1", "one", null), ...turn("t2", "two"), ...turn("t3", "three")])).toEqual([
      ["one", true],
      ["two", "Can't edit this message"],
      ["three", true],
    ]);
    expect(users([...turn("t1", "one"), { type: "turn/started", turnId: "t2", input: input("two") }])).toEqual([
      ["one", "Wait for the reply"],
      ["two", "Wait for the reply"],
    ]);
  });

  it("drops the edited turn and all after it, with their switches and requests", () => {
    const rows = buildTimelineRows(
      stateOf([
        ...turn("t1", "one"),
        ...turn("t2", "two"),
        { type: "session/modelChanged", model: "m", label: "Opus" },
        ...turn("t3", "three"),
        { type: "thread/rewound", turnId: "t2" },
        ...turn("t4", "two, better"),
      ]),
    );
    expect(rows.map((r) => (r.kind === "user" || r.kind === "assistant" || r.kind === "notice" ? r.text : r.kind))).toEqual([
      "one",
      "re one",
      "two, better",
      "re two, better",
    ]);
  });
});

describe("timeline rows", () => {
  it("gives only the closing reply of a completed turn its files' start time", () => {
    const say = (id: string, text: string) => ({ type: "item/completed", turnId: "u1", item: { id, kind: "agentMessage", status: "completed", text } }) as const;
    const running = stateOf([{ type: "turn/started", turnId: "u1", input: null }, say("m1", "Reading `a.md`."), say("m2", "Done: `b.md`.")]);
    expect(buildTimelineRows(running).filter((r) => r.kind === "assistant" && r.filesSince !== undefined)).toEqual([]);
    const done = applyThreadEvents(running, [{ threadId: "t", seq: 9, at: 2000, event: { type: "turn/completed", turnId: "u1", status: "completed", error: null, usage: null } }]);
    const rows = buildTimelineRows(done).filter((r) => r.kind === "assistant");
    expect(rows.map((r) => [r.id, r.kind === "assistant" && r.filesSince])).toEqual([["m1", undefined], ["m2", 1000]]);
  });

  it("shows the closing reply's files once answered, before Stop hooks complete the turn, and not if it goes on", () => {
    const say = (id: string) => ({ type: "item/completed", turnId: "u1", item: { id, kind: "agentMessage", status: "completed", text: "Done: `b.md`." } }) as const;
    const answered = stateOf([{ type: "turn/started", turnId: "u1", input: null }, say("m1"), { type: "turn/answered", turnId: "u1" }]);
    const files = (state: typeof answered) =>
      buildTimelineRows(state).flatMap((r) => (r.kind === "assistant" && r.filesSince !== undefined ? [[r.id, r.filesSince, r.turnEnd]] : []));
    expect(files(answered)).toEqual([["m1", 1000, undefined]]);
    // A Stop hook made the agent go on: the cards wait for the new closing reply.
    const resumed = stateOf([
      { type: "turn/started", turnId: "u1", input: null },
      say("m1"),
      { type: "turn/answered", turnId: "u1" },
      { type: "item/started", turnId: "u1", item: { id: "m2", kind: "agentMessage", status: "running", text: "" } },
    ]);
    expect(files(resumed)).toEqual([]);
  });

  it("ends a finished turn's reply with its fork point, and a fork with a marker after the copied turns", () => {
    const turn = (id: string, forkPoint: string | null): ThreadEvent[] => [
      { type: "turn/started", turnId: id, input: { text: "go", clientRequestId: id } },
      { type: "item/completed", turnId: id, item: { id: `${id}:m`, kind: "agentMessage", status: "completed", text: "Done." } },
      { type: "turn/completed", turnId: id, status: "completed", error: null, usage: { durationMs: 41_000, costUsd: 0.08 } as never, forkPoint },
    ];
    const state = stateOf([...turn("u1", "p1"), { type: "thread/forked", fromThreadId: "o", fromTitle: "Fix it", turn: 1 }, ...turn("u2", null)]);
    const rows = buildTimelineRows(state);
    expect(rows.map((r) => r.kind)).toEqual(["user", "assistant", "fork", "user", "assistant"]);
    expect(rows[1]).toMatchObject({ turnEnd: { index: 1, durationMs: 41_000, costUsd: 0.08, forkable: true } });
    expect(rows[4]).toMatchObject({ turnEnd: { index: 2, forkable: false } });
    // It has worked since (turn u2), so it can no longer move into a worktree.
    expect(rows[2]).toMatchObject({ fromThreadId: "o", fromTitle: "Fix it", turn: 1, worktree: null, canMove: false });
    const fresh = stateOf([...turn("u1", "p1"), { type: "thread/forked", fromThreadId: "o", fromTitle: "Fix it", turn: 1 }]);
    expect(buildTimelineRows(fresh).at(-1)).toMatchObject({ kind: "fork", canMove: true });
    const moved = applyThreadEvents(fresh, [{ threadId: "t", seq: 99, at: 5000, event: { type: "thread/worktree", branch: "lotus/f-x" } }]);
    expect(buildTimelineRows(moved).at(-1)).toMatchObject({ kind: "fork", worktree: "lotus/f-x", canMove: false });
  });

  it("puts a background sub-agent's late steps back under its Agent call", () => {
    const agent = { id: "ag", kind: "tool", status: "completed", name: "Agent", input: { subagent_type: "general-purpose", description: "Count" }, output: "launched" } as const;
    const state = stateOf([
      { type: "turn/started", turnId: "u1", input: { text: "go", clientRequestId: "r" } },
      { type: "item/completed", turnId: "u1", item: agent },
      { type: "item/completed", turnId: "u1", item: { id: "m1", kind: "agentMessage", status: "completed", text: "Waiting for it." } },
      { type: "turn/completed", turnId: "u1", status: "completed", error: null, usage: null },
      // The agent reports after the turn ended: Claude runs a turn of its own for it.
      { type: "turn/started", turnId: "u2", input: null },
      { type: "item/completed", turnId: "u2", item: { id: "c1", kind: "command", status: "completed", command: "ls", description: null, output: "", parentId: "ag" } },
      { type: "item/completed", turnId: "u2", item: { id: "s1", kind: "agentMessage", status: "completed", text: "2 files", parentId: "ag" } },
      { type: "item/completed", turnId: "u2", item: { id: "m2", kind: "agentMessage", status: "completed", text: "It found 2 files." } },
    ]);
    const rows = buildTimelineRows(state);
    expect(rows.map((r) => r.kind)).toEqual(["user", "work", "assistant", "assistant"]);
    const work = rows[1].kind === "work" ? rows[1] : null;
    expect(work?.steps.map((s) => [s.item.id, s.depth])).toEqual([["ag", 0], ["c1", 1], ["s1", 1]]);
  });

  it("titles a Lotus delegation by its model, and counts the wait as part of it", () => {
    const call = (id: string, name: string, input: unknown) => ({ id, kind: "tool", status: "completed", name, input, output: null }) as const;
    const delegate = call("d", "mcp__lotus-dev__lotus_chat_delegate", { provider: "codex", model: "gpt-6.1-terra", title: "Count Rust files" });
    const wait = call("w", "lotus-dev · lotus_chat_wait", { chatIds: ["a", "b"] });
    expect(stepTitle(delegate, null)).toBe("Delegated to gpt-6.1-terra: Count Rust files");
    expect(stepTitle(wait, null)).toBe("Waited for 2 agents");
    const step = (item: WorkStep["item"]): WorkStep => ({ item, title: "", startedAt: 0, endedAt: 0, interaction: null, depth: 0 });
    expect(summarizeSteps([step(call("t", "ToolSearch", {})), step(delegate), step(delegate), step(wait)])).toBe("Delegated 2 agents");
  });

  it("splits work around agent messages and shows a pending approval", () => {
    const state = stateOf([
      { type: "session/configured", providerSessionId: "s", model: "m", authSource: "accountLogin", cwd: "/w" },
      { type: "turn/started", turnId: "u1", input: { text: "go", clientRequestId: "r" } },
      { type: "item/started", turnId: "u1", item: { id: "r1", kind: "fileRead", status: "running", path: "/w/a.ts", lineCount: null } },
      { type: "item/completed", turnId: "u1", item: { id: "r1", kind: "fileRead", status: "completed", path: "/w/a.ts", lineCount: 3 } },
      { type: "item/completed", turnId: "u1", item: { id: "m1", kind: "agentMessage", status: "completed", text: "Now I edit." } },
      { type: "item/started", turnId: "u1", item: { id: "e1", kind: "fileChange", status: "running", path: "/w/a.ts", change: "edit", patch: null } },
      {
        type: "interaction/requested",
        turnId: "u1",
        interaction: { id: "i1", kind: "toolPermission", itemId: "e1", toolName: "Edit", input: {}, blockedPath: null },
      },
    ]);
    const rows = buildTimelineRows(state);
    expect(rows.map((r) => r.kind)).toEqual(["user", "work", "assistant", "work"]);
    expect(rows[1]).toMatchObject({ summary: "Read 1 file", status: "completed", startedAt: 1002, endedAt: 1003 });
    expect(rows[3]).toMatchObject({ summary: "Edited 1 file", status: "needsApproval", endedAt: null });
  });

  it("shows an approval row when the request names no known step", () => {
    const state = stateOf([
      {
        type: "interaction/requested",
        turnId: null,
        interaction: { id: "i1", kind: "toolPermission", itemId: null, toolName: "Bash", input: {}, blockedPath: null },
      },
    ]);
    expect(buildTimelineRows(state)).toMatchObject([{ kind: "approval", id: "i1" }]);
  });

  it("hides finished empty thoughts once the run ends, but shows a running one", () => {
    const thought = (status: "running" | "completed"): ThreadEvent => ({
      type: "item/started",
      turnId: "u1",
      item: { id: `t-${status}`, kind: "reasoning", status, text: "" },
    });
    const done: ThreadEvent = { type: "turn/completed", turnId: "u1", status: "completed", error: null, usage: null };
    expect(buildTimelineRows(stateOf([{ type: "turn/started", turnId: "u1", input: null }, thought("completed"), done]))).toEqual([]);
    expect(buildTimelineRows(stateOf([{ type: "turn/started", turnId: "u1", input: null }, thought("running")]))).toMatchObject([
      { kind: "work", status: "running", steps: [{ title: "Thinking" }] },
    ]);
  });

  it("hides a finished message that was emptied, but not a streaming one", () => {
    const message = (id: string, status: "running" | "completed"): ThreadEvent => ({
      type: "item/started",
      turnId: "u1",
      item: { id, kind: "agentMessage", status, text: "" },
    });
    const rows = buildTimelineRows(stateOf([{ type: "turn/started", turnId: "u1", input: null }, message("cut", "completed"), message("live", "running")]));
    expect(rows).toMatchObject([{ kind: "assistant", id: "live" }]);
  });

  it("shows a failed turn and a crashed session as error notices", () => {
    const rows = buildTimelineRows(
      stateOf([
        { type: "turn/started", turnId: "u1", input: null },
        { type: "turn/completed", turnId: "u1", status: "failed", error: "rate limited", usage: null },
        { type: "session/ended", error: "claude exited" },
      ]),
    );
    expect(rows).toMatchObject([
      { kind: "notice", tone: "error", text: "rate limited" },
      { kind: "notice", tone: "error", text: "claude exited" },
    ]);
  });

  it("drops an ended session's notice once a later turn runs, as a revived remote agent does", () => {
    const state = stateOf([
      { type: "session/ended", error: "Lotus closed while this was running." },
      { type: "turn/started", turnId: "u2", input: null },
    ]);
    expect(state.session.ended).toBe(false);
    expect(buildTimelineRows(state).filter((r) => r.kind === "notice")).toEqual([]);
  });

  it("summarizes steps with plurals in a fixed order", () => {
    const step = (item: WorkStep["item"]): WorkStep => ({ item, title: "", startedAt: 0, endedAt: 0, interaction: null, depth: 0 });
    const read = (id: string) => step({ id, kind: "fileRead", status: "completed", path: id, lineCount: null });
    expect(
      summarizeSteps([
        step({ id: "c", kind: "command", status: "completed", command: "ls", description: null, output: null }),
        read("a"),
        read("b"),
        step({ id: "x", kind: "tool", status: "completed", name: "WebFetch", input: {}, output: null }),
      ]),
    ).toBe("Read 2 files, ran 1 command, used 1 tool");
    expect(summarizeSteps([])).toBe("Worked");
  });

  it("keeps the run live in the gap between two steps, and ends it once the reply starts", () => {
    const tool = (id: string, status: "running" | "completed"): ThreadEvent => ({
      type: status === "running" ? "item/started" : "item/completed",
      turnId: "u1",
      item: { id, kind: "tool", status, name: "mcp__notionApi__API-query-data-source", input: {}, output: null },
    });
    const start: ThreadEvent[] = [
      { type: "turn/started", turnId: "u1", input: null },
      { type: "item/completed", turnId: "u1", item: { id: "t0", kind: "reasoning", status: "completed", text: "" } },
      tool("s1", "running"),
      tool("s1", "completed"),
    ];
    // The gap: every step is done, but the turn still runs.
    const gap = buildTimelineRows(stateOf(start));
    expect(gap).toMatchObject([{ kind: "work", id: "u1:work:t0", status: "running", endedAt: null }]);
    expect(gap[0].kind === "work" && gap[0].steps.length).toBe(2);
    // The reply ends the run: done, its time fixed, the empty thought gone, the same row.
    const replied = buildTimelineRows(
      stateOf([...start, { type: "item/started", turnId: "u1", item: { id: "m1", kind: "agentMessage", status: "running", text: "Done" } }]),
    );
    expect(replied[0]).toMatchObject({ kind: "work", id: "u1:work:t0", status: "completed", endedAt: 1003, summary: "Used 1 tool" });
    // A finished turn is never held live.
    const ended = buildTimelineRows(stateOf([...start, { type: "turn/completed", turnId: "u1", status: "completed", error: null, usage: null }]));
    expect(ended[0]).toMatchObject({ status: "completed" });
  });

  it("titles MCP tools and cd-prefixed commands for reading", () => {
    expect(toolParts("mcp__notionApi__API-query-data-source")).toEqual({ tool: "query data source", source: "notion" });
    expect(toolParts("notionApi · API-retrieve-page-markdown")).toEqual({ tool: "retrieve page markdown", source: "notion" });
    expect(toolParts("mcp__plugin_playwright_playwright__browser_click")).toEqual({ tool: "browser click", source: "playwright" });
    expect(toolParts("WebFetch")).toEqual({ tool: "WebFetch", source: null });
    const command = (c: string) =>
      stepTitle({ id: "c", kind: "command", status: "completed", command: c, description: null, output: null }, "/w");
    expect(command("cd /Users/me/vault; sed -n 1,140p a.md")).toBe("Ran sed -n 1,140p a.md");
    expect(command("cd /w/x && ls")).toBe("Ran ls");
    expect(command("cd /tmp")).toBe("Ran cd /tmp");
  });

  it("shows paths relative to the thread folder, also behind /private", () => {
    expect(displayPath("/var/x/src/a.ts", "/var/x")).toBe("src/a.ts");
    expect(displayPath("/private/var/x/src/a.ts", "/var/x")).toBe("src/a.ts");
    expect(displayPath("/etc/hosts", "/var/x")).toBe("/etc/hosts");
    expect(displayPath("/var/xy/a.ts", "/var/x")).toBe("/var/xy/a.ts");
  });
});

describe("sameTimelineRow", () => {
  it("keeps rows of a finished turn equal while a later turn streams", () => {
    const events: ThreadEvent[] = [
      { type: "turn/started", turnId: "u1", input: { text: "hi", clientRequestId: "r1" } },
      { type: "item/started", turnId: "u1", item: { id: "c", kind: "command", status: "running", command: "ls", description: null, output: null } },
      { type: "item/completed", turnId: "u1", item: { id: "c", kind: "command", status: "completed", command: "ls", description: null, output: "a" } },
      { type: "turn/completed", turnId: "u1", status: "completed", error: null, usage: null },
      { type: "turn/started", turnId: "u2", input: { text: "again", clientRequestId: "r2" } },
      { type: "item/started", turnId: "u2", item: { id: "a", kind: "agentMessage", status: "running", text: "" } },
      { type: "item/delta", turnId: "u2", itemId: "a", delta: "Hel" },
    ];
    const state = stateOf(events);
    const next = applyThreadEvents(state, [
      { threadId: "t", seq: events.length + 1, at: 2000, event: { type: "item/delta", turnId: "u2", itemId: "a", delta: "lo" } },
    ]);
    const before = buildTimelineRows(state);
    const after = buildTimelineRows(next);
    expect(before.map((row, i) => sameTimelineRow(row, after[i]))).toEqual([true, true, true, false]);
  });
});

describe("model switches", () => {
  const turn = (id: string): ThreadEvent[] => [
    { type: "turn/started", turnId: id, input: { text: id, clientRequestId: id } },
    { type: "turn/completed", turnId: id, status: "completed", error: null, usage: null },
  ];

  it("shows a switch after the turn it followed; a pick before the first message is not a switch", () => {
    const state = stateOf([
      { type: "session/modelChanged", model: "sonnet", label: "Sonnet 5.5" },
      ...turn("u1"),
      { type: "session/modelChanged", model: "haiku", label: "Haiku 5.5" },
      ...turn("u2"),
    ]);
    expect(state.session.model).toBe("haiku");
    expect(buildTimelineRows(state).map((row) => (row.kind === "notice" ? row.text : row.kind))).toEqual([
      "user",
      "Switched to Haiku 5.5",
      "user",
    ]);
  });

  it("shows a permission switch like a model switch", () => {
    const state = stateOf([...turn("u1"), { type: "session/permissionChanged", mode: "bypassPermissions", label: "Allow everything" }, ...turn("u2")]);
    expect(buildTimelineRows(state).map((row) => (row.kind === "notice" ? row.text : row.kind))).toEqual(["user", "Switched to Allow everything", "user"]);
  });

  it("a later session report replaces the picked alias with the model it resolved to", () => {
    const state = stateOf([
      { type: "session/modelChanged", model: "sonnet", label: "Sonnet 5.5" },
      { type: "session/configured", providerSessionId: "s", model: "claude-sonnet-5-5", authSource: "accountLogin", cwd: "/w" },
    ]);
    expect(state.session.model).toBe("claude-sonnet-5-5");
  });
});

describe("quiet gaps", () => {
  const turn = (id: string, start: number, end: number | null): ThreadEventEnvelope[] => [
    { threadId: "t", seq: start, at: start, event: { type: "turn/started", turnId: id, input: { text: id, clientRequestId: id } } },
    ...(end === null ? [] : [{ threadId: "t", seq: end, at: end, event: { type: "turn/completed", turnId: id, status: "completed", error: null, usage: null } } as ThreadEventEnvelope]),
  ];
  const kinds = (envs: ThreadEventEnvelope[]) => buildTimelineRows(applyThreadEvents(emptyThreadState("t"), envs)).map((r) => r.kind);

  it("puts a divider before a turn that starts GAP_MS or more after the last one ended", () => {
    const rows = buildTimelineRows(applyThreadEvents(emptyThreadState("t"), [...turn("u1", 1, 10), ...turn("u2", 10 + GAP_MS, 10 + GAP_MS + 5)]));
    expect(rows.map((r) => r.kind)).toEqual(["user", "gap", "user"]);
    expect(rows[1]).toMatchObject({ id: "u2:gap", at: 10 + GAP_MS, afterMs: GAP_MS });
  });

  it("no divider for a shorter pause, or before the first turn", () => {
    expect(kinds([...turn("u1", 1, 10), ...turn("u2", 9 + GAP_MS, null)])).toEqual(["user", "user"]);
  });

  it("measures from the start of a turn that never ended (Lotus closed mid-run)", () => {
    expect(kinds([...turn("u1", 1, null), ...turn("u2", 1 + GAP_MS, null)])).toEqual(["user", "gap", "user"]);
  });

  it("says the pause in minutes, hours or days", () => {
    expect([30, 90, 17 * 60, 3 * 24 * 60].map((m) => gapDuration(m * 60_000))).toEqual(["30 min", "2 hours", "17 hours", "3 days"]);
  });
});

describe("/clear", () => {
  it("shows a notice instead of the user's /clear message; the history above stays", () => {
    const state = stateOf([
      { type: "turn/started", turnId: "u1", input: { text: "hi", clientRequestId: "r1" } },
      { type: "turn/completed", turnId: "u1", status: "completed", error: null, usage: null },
      { type: "turn/started", turnId: "u2", input: { text: "/clear", clientRequestId: "r2" } },
      { type: "turn/completed", turnId: "u2", status: "completed", error: null, usage: null },
    ]);
    expect(buildTimelineRows(state).map((row) => (row.kind === "notice" ? row.text : row.kind))).toEqual(["user", "Context cleared"]);
  });

  it("shows /compact as a line that says when it is done", () => {
    const running = stateOf([{ type: "turn/started", turnId: "u1", input: { text: "/compact", clientRequestId: "r1" } }]);
    expect(buildTimelineRows(running).map((row) => (row.kind === "notice" ? row.text : row.kind))).toEqual(["Compacting context…"]);
    const done = applyThreadEvents(running, [
      { threadId: "t", seq: 2, at: 2000, event: { type: "turn/completed", turnId: "u1", status: "completed", error: null, usage: null } },
    ]);
    expect(buildTimelineRows(done).map((row) => (row.kind === "notice" ? row.text : row.kind))).toEqual(["Context compacted"]);
    const failed = applyThreadEvents(running, [
      { threadId: "t", seq: 2, at: 2000, event: { type: "turn/completed", turnId: "u1", status: "failed", error: "no", usage: null } },
    ]);
    expect(buildTimelineRows(failed).map((row) => (row.kind === "notice" ? row.text : row.kind))).toEqual(["user", "no"]);
  });

  it("reads a command Claude reports as the turn's first item (no input), as recorded live", () => {
    const state = stateOf([
      { type: "turn/started", turnId: "u1", input: null },
      { type: "item/completed", turnId: "u1", item: { id: "m", kind: "userMessage", status: "completed", text: "/compact", clientRequestId: "r1" } },
      { type: "turn/completed", turnId: "u1", status: "completed", error: null, usage: null },
    ]);
    expect(buildTimelineRows(state).map((row) => (row.kind === "notice" ? row.text : row.kind))).toEqual(["Context compacted"]);
  });

  it("keeps /clear as a message when the agent answered it as text", () => {
    const state = stateOf([
      { type: "turn/started", turnId: "u1", input: { text: "/clear", clientRequestId: "r1" } },
      { type: "item/completed", turnId: "u1", item: { id: "a", kind: "agentMessage", status: "completed", text: "Konteks sudah dibersihkan." } },
      { type: "turn/completed", turnId: "u1", status: "completed", error: null, usage: null },
    ]);
    expect(buildTimelineRows(state).map((row) => row.kind)).toEqual(["user", "assistant"]);
  });
});

describe("shownText", () => {
  it("drops Lotus's delegation note and keeps the task", () => {
    expect(shownText('<lotus-delegation from="abc">You are a sub-agent.\nReport.</lotus-delegation>\n\nCount the files.')).toBe("Count the files.");
  });
  it("leaves any other message alone, even one that mentions the tag later", () => {
    expect(shownText("Explain <lotus-delegation> to me")).toBe("Explain <lotus-delegation> to me");
  });
});

describe("lastLine", () => {
  const reply = (text: string) => ({ kind: "assistant" as const, id: text, turnId: "t", text, streaming: false });
  it("takes the last reply's first non-empty line, without Markdown marks", () => {
    expect(lastLine([reply("old"), reply("\n## **Done**: `a.ts` fixed\nmore")])).toBe("Done: a.ts fixed");
    expect(lastLine([reply("- item one")])).toBe("item one");
  });
  it("skips user rows and empty replies; nothing yields empty", () => {
    const user = { kind: "user" as const, id: "u", turnId: "t", text: "hi", clientRequestId: "c", attachments: [] };
    expect(lastLine([reply("answer"), reply("  "), user])).toBe("answer");
    expect(lastLine([])).toBe("");
  });
});

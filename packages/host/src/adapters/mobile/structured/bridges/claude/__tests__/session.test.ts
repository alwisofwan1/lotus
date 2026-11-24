import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildArgs } from "../args.js";
import { ClaudeStreamSession } from "../session.js";
import { approvalAnswerFor } from "../pending.js";
import { claudeBridge, claudePermissionMode } from "../index.js";

const FAKE = join(__dirname, "fake-claude.mjs");

const open: ClaudeStreamSession[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

/**
 * A session pointed at the fake CLI. Approvals off by default: the fake never asks, and a
 * real socket per test is a listener and a temp directory for nothing.
 */
function session(script: string, approvals = false): ClaudeStreamSession {
  process.env["FAKE_CLAUDE"] = script;
  const s = new ClaudeStreamSession({
    paneId: "ss-claude",
    cwd: process.cwd(),
    command: process.execPath,
    args: [FAKE],
    approvals,
  });
  open.push(s);
  return s;
}

describe("ClaudeStreamSession", () => {
  it("resolves a prompt when the turn ends, with the streamed text assembled", async () => {
    const s = session("ok");
    await s.start();
    await s.prompt("say hello");
    const turn = s.conversation.page().turns[0];
    expect(turn?.stopReason).toBe("end_turn");
    expect(turn?.parts.find((p) => p.type === "assistant_text")).toMatchObject({
      text: "hello say hello",
      state: "done",
    });
  });

  it("keeps one process across turns, on the runner's own session id", async () => {
    // The finding this bridge rests on: a second prompt on the same stdin continues the
    // same conversation, so a cell here is one process rather than one per ask.
    const s = session("ok");
    await s.start();
    await s.prompt("first");
    await s.prompt("second");
    expect(s.conversation.page().turns).toHaveLength(2);
    expect(s.thread).toBe("11111111-2222-3333-4444-555555555555");
    expect(s.alive).toBe(true);
  });

  it("pairs a tool call with its result", async () => {
    const s = session("tools");
    await s.start();
    await s.prompt("read it");
    const call = s.conversation.page().turns[0]?.parts.find((p) => p.type === "tool_call");
    expect(call).toMatchObject({ toolName: "Read", kind: "read", status: "completed" });
  });

  it("reads the rate-limit window off the same stream", async () => {
    const s = session("ok");
    await s.start();
    await s.prompt("go");
    expect(s.conversation.rateLimit).toMatchObject({ status: "allowed", window: "five_hour" });
  });

  it("never claims a question is waiting, and refuses an answer", async () => {
    const s = session("ok");
    await s.start();
    await s.prompt("go");
    expect(s.decide("1")).toBe(false);
    expect(s.conversation.pendingPermission()).toBeUndefined();
  });

  it("does not wait forever when the process dies mid-turn", async () => {
    // A turn whose `result` can no longer come must not leave `prompt()` hanging — that is
    // a cell the phone would show as working, for as long as the host lives.
    const s = session("silent");
    await s.start();
    const turn = s.prompt("go");
    setTimeout(() => s.close(), 50);
    await expect(turn).resolves.toBeUndefined();
  });

  it("records an error turn when asked after the process is gone", async () => {
    const s = session("ok");
    await s.start();
    s.close();
    await new Promise((r) => setTimeout(r, 50));
    await s.prompt("too late");
    expect(s.conversation.page().turns.at(-1)?.stopReason).toBe("error");
  });
});

describe("the account a cell runs as", () => {
  it("sets CLAUDE_CONFIG_DIR for this cell only, and nothing else", async () => {
    // The failure this closes: a headless cell used to inherit whatever profile the host
    // process had, and a phone had no way to say which account to work as.
    process.env["FAKE_CLAUDE"] = "env";
    const s = new ClaudeStreamSession({
      paneId: "ss-claude",
      cwd: process.cwd(),
      command: process.execPath,
      args: [FAKE],
      approvals: false,
      configDir: "/tmp/lotus-profile-x",
    });
    open.push(s);
    await s.start();
    await s.prompt("what dir");
    const said = s.conversation.page().turns[0]?.parts.find((p) => p.type === "assistant_text");
    expect(said?.type === "assistant_text" ? said.text : "").toContain("/tmp/lotus-profile-x");
  });

  it("leaves the inherited profile alone when none was chosen", async () => {
    // Deliberate: a host launched from an activated shell is already on the right account.
    process.env["FAKE_CLAUDE"] = "env";
    delete process.env["CLAUDE_CONFIG_DIR"];
    const s = session("env");
    await s.start();
    await s.prompt("what dir");
    const said = s.conversation.page().turns[0]?.parts.find((p) => p.type === "assistant_text");
    expect(said?.type === "assistant_text" ? said.text : "").toContain("dir=none");
  });

  it("refuses a profile this machine does not have, by name", () => {
    // Falling back to the ambient account would be the silent-wrong-account failure.
    const bridge = claudeBridge();
    expect(() => bridge.create({ paneId: "p", cwd: "/w", profileId: "not-a-real-account" }))
      .toThrow(/no Claude profile named "not-a-real-account"/);
  });
});

describe("buildArgs", () => {
  it("asks for the streaming protocol, both ways", () => {
    const args = buildArgs({ paneId: "p", cwd: "/w" });
    expect(args).toEqual(expect.arrayContaining([
      "--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    ]));
    // Streaming text is the point of this mode.
    expect(args).toContain("--include-partial-messages");
  });

  it("passes only what was asked for", () => {
    expect(buildArgs({ paneId: "p", cwd: "/w" })).not.toContain("--model");
    const tuned = buildArgs({ paneId: "p", cwd: "/w", model: "opus", effort: "high", resumeSessionId: "s-1" });
    expect(tuned).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "high", "--resume", "s-1"]));
    // Chat Attachment copies are read without asking, as on the desktop.
    expect(buildArgs({ paneId: "p", cwd: "/w", readableDir: "/h/att" })).toEqual(expect.arrayContaining(["--allowedTools", "Read(//h/att/**)"]));
  });
});

describe("claudePermissionMode", () => {
  it("maps the shared scale onto Claude's own words", () => {
    expect(claudePermissionMode("read-only")).toBe("plan");
    expect(claudePermissionMode("plan")).toBe("plan");
    expect(claudePermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(claudePermissionMode("full-access")).toBe("bypassPermissions");
    expect(claudePermissionMode("yolo")).toBe("bypassPermissions");
  });

  it("reads an unknown stop as ask, never as run free", () => {
    expect(claudePermissionMode("something-newer")).toBe("manual");
    expect(claudePermissionMode(undefined)).toBe("manual");
  });
});

/**
 * Answering a **question** is not the same act as granting a permission, and the difference
 * is on the wire: the chosen label has to ride back as the tool's own input, rewritten, or
 * the tool runs and reports that nobody answered (probed against the real CLI, 2026-09-08).
 */
describe("what the operator's answer is turned into", () => {
  const asking = {
    questions: [
      { question: "Tabs or spaces?", options: [{ label: "Spaces" }, { label: "Tabs" }] },
    ],
  };

  it("carries the chosen label back inside the tool's input", () => {
    const answer = approvalAnswerFor(
      { toolName: "AskUserQuestion", input: asking },
      { key: "2", label: "Tabs", kind: "allow_once" },
    );

    expect(answer).toEqual({
      behavior: "allow",
      updatedInput: { ...asking, answers: { "Tabs or spaces?": "Tabs" } },
    });
  });

  it("grants an ordinary tool without touching what it was called with", () => {
    const input = { command: "rm -f notes.txt" };
    expect(approvalAnswerFor({ toolName: "Bash", input }, { key: "1", label: "Allow once", kind: "allow_once" }))
      .toEqual({ behavior: "allow" });
  });

  /**
   * The shape is not invented — it is what the CLI was proved to honour on 2026-09-08. Two Bash
   * calls behind one of these were asked about **once**; the control without it was asked twice,
   * and both commands ran in both runs.
   */
  it("turns a standing grant into a session rule the runner enforces", () => {
    const answer = approvalAnswerFor(
      { toolName: "Bash", input: { command: "rm -f doomed.txt" } },
      { key: "2", label: "Allow all Bash until this cell closes", kind: "allow_always" },
    );

    expect(answer).toEqual({
      behavior: "allow",
      updatedPermissions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    });
  });

  /**
   * `destination: "session"` and nothing wider. A rule written to the operator's settings would
   * outlive the cell that asked for it — and a permission granted from a phone, once, must not
   * quietly become a permission the machine holds forever.
   */
  it("never writes a rule that outlives the cell", () => {
    const answer = approvalAnswerFor(
      { toolName: "Write", input: {} },
      { key: "2", label: "Allow all Write until this cell closes", kind: "allow_always" },
    );
    const rules = "updatedPermissions" in answer ? answer.updatedPermissions : undefined;

    expect(rules?.every((r) => r.destination === "session")).toBe(true);
  });

  it("refuses when the operator declined, whichever tool asked", () => {
    expect(approvalAnswerFor({ toolName: "Bash", input: {} }, { key: "2", label: "Deny", kind: "reject_once" }))
      .toMatchObject({ behavior: "deny" });
  });
});

/**
 * **Postur berhenti jadi keputusan sekali seumur sel.**
 *
 * `--permission-mode` adalah flag spawn, jadi melonggarkan sel berarti membunuhnya dan kehilangan
 * percakapannya — di HP itu justru disadari setelah agent bekerja separuh jalan. Probed
 * 2026-09-09: CLI menerima `control_request` di stdin yang sama, menjawab `control_response`, dan
 * efeknya nyata — sel yang di-spawn `manual` berhenti menggerbangi `rm -f` setelahnya.
 *
 * Jalan yang **tidak** diambil: menjalankan semuanya `manual` lalu Lotus yang menjawab otomatis.
 * Probe membatalkannya — `acceptEdits` melewatkan edit filesystem tapi tetap menggerbangi
 * jaringan, jadi menirunya berarti mereproduksi klasifikator CLI, dan salahnya ke arah permisif.
 * Di sini CLI tetap yang mengklasifikasi.
 */
describe("changing a cell's posture while it runs", () => {
  it("asks the runner to change it, and reports the mode it settled on", async () => {
    const s = session("ok");
    await s.start();

    await s.setPermissionMode("acceptEdits");

    expect(s.permissionMode).toBe("acceptEdits");
    expect(s.alive).toBe(true);
  });

  it("keeps the same process, so the conversation survives the change", async () => {
    const s = session("ok");
    await s.start();
    await s.prompt("first");
    const before = s.thread;

    await s.setPermissionMode("acceptEdits");
    await s.prompt("second");

    expect(s.thread).toBe(before);
    expect(s.conversation.page().turns).toHaveLength(2);
  });

  /**
   * The control channel shares one stdout with the conversation. A response that reached the
   * timeline would draw as an `unknown` part — protocol chatter rendered to the operator as a
   * step the agent took.
   */
  it("keeps control traffic out of the transcript", async () => {
    const s = session("ok");
    await s.start();
    await s.setPermissionMode("acceptEdits");
    await s.prompt("say hello");

    const parts = s.conversation.page().turns.flatMap((t) => t.parts);
    expect(parts.filter((p) => p.type === "unknown")).toHaveLength(0);
  });
});

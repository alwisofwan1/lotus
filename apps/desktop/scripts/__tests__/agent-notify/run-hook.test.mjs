// In-process orchestrator tests. Exercises runHook() end-to-end against a
// real (temporary) drop directory but without spawning a subprocess.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runHook, DROP_DIR_SOFT_CAP } from "../../agent-notify/run-hook.mjs";

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lotus-runhook-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function baseCtx(overrides = {}) {
  return {
    argv: [],
    args: { agent: "claude", event: "stop" },
    stdin: "",
    env: {},
    dropDir: dir,
    timestamp: 1714000000000,
    randomSuffix: "abc123",
    pid: 999,
    cwd: "/tmp/proj",
    ...overrides,
  };
}

function readDropFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

describe("runHook — which agent ran the hook", () => {
  it("files a Claude-format hook under cursor when Cursor spawned it", () => {
    // Cursor loads ~/.claude/settings.json hooks, whose commands say `--agent claude`.
    // CURSOR_VERSION is set on every hook process Cursor spawns.
    const result = runHook(baseCtx({ env: { CURSOR_VERSION: "2026.08.25", LOTUS_PANE_ID: "p" }, args: { agent: "claude", event: "tool-pre" }, stdin: JSON.stringify({ tool_name: "Shell", tool_input: { command: "echo pong" } }) }));
    expect(result.outcome).toBe("ok");
    expect(readDropFile(result.filePath).agentType).toBe("cursor");
  });

  it("also recognises Cursor from the payload's cursor_version when the env is scrubbed", () => {
    const result = runHook(baseCtx({ args: { agent: "claude", event: "stop" }, stdin: JSON.stringify({ cursor_version: "2026.08.25", conversation_id: "conv-1" }) }));
    expect(readDropFile(result.filePath).agentType).toBe("cursor");
    expect(readDropFile(result.filePath).sessionId).toBe("conv-1");
  });

  it("leaves a non-Claude label alone even under Cursor's env", () => {
    const result = runHook(baseCtx({ env: { CURSOR_VERSION: "1" }, args: { agent: "codex", event: "stop" } }));
    expect(readDropFile(result.filePath).agentType).toBe("codex");
  });
});

describe("runHook — pane correlation", () => {
  it("captures LOTUS_PANE_ID from the inherited env so canvas agents correlate by pane, not cwd", () => {
    // Multiple canvas agents share one project cwd — the pane id is the only unambiguous key.
    const result = runHook(baseCtx({ env: { LOTUS_PANE_ID: "node-atlas-1" } }));
    expect(result.outcome).toBe("ok");
    expect(readDropFile(result.filePath).paneId).toBe("node-atlas-1");
  });

  it("writes paneId null when the env var is absent (codespace terminals, external CLIs)", () => {
    const result = runHook(baseCtx());
    expect(readDropFile(result.filePath).paneId).toBeNull();
  });
});

describe("runHook — happy path", () => {
  it("writes a v1 drop file with status from event mapping", () => {
    const result = runHook(baseCtx());
    expect(result.outcome).toBe("ok");
    expect(result.filePath).toBeDefined();
    const payload = readDropFile(result.filePath);
    expect(payload).toMatchObject({
      version: 1,
      agentType: "claude",
      event: "stop",
      status: "idle",
      title: "Finished working",
      cwd: "/tmp/proj",
      pid: 999,
      timestamp: 1714000000000,
    });
  });

  it("uses Claude Stop payload from stdin", () => {
    const stdin = JSON.stringify({
      session_id: "sess-1",
      last_assistant_message: "Done.",
      prompt: "Write a test",
    });
    const result = runHook(baseCtx({ stdin }));
    expect(result.outcome).toBe("ok");
    const payload = readDropFile(result.filePath);
    expect(payload.sessionId).toBe("sess-1");
    expect(payload.body).toBe("Done.");
    expect(payload.userPrompt).toBe("Write a test");
  });

  it("uses Codex agent-turn-complete payload from stdin", () => {
    const stdin = JSON.stringify({
      session: { id: "codex-9" },
      input_messages: [
        { content: "first" },
        { content: "Refactor auth" },
      ],
      last_assistant_message: "Refactor complete.",
    });
    const result = runHook(baseCtx({ args: { agent: "codex", event: "stop" }, stdin }));
    const payload = readDropFile(result.filePath);
    expect(payload.sessionId).toBe("codex-9");
    expect(payload.userPrompt).toBe("Refactor auth");
    expect(payload.body).toBe("Refactor complete.");
  });

  it("CLI flags override stdin for body and user-prompt", () => {
    const stdin = JSON.stringify({ body: "from stdin", prompt: "stdin prompt" });
    const result = runHook(
      baseCtx({
        args: {
          agent: "claude",
          event: "stop",
          body: "from flag",
          "user-prompt": "flag prompt",
        },
        stdin,
      }),
    );
    const payload = readDropFile(result.filePath);
    expect(payload.body).toBe("from flag");
    expect(payload.userPrompt).toBe("flag prompt");
  });

  it("CLI session-id flag wins over payload session_id", () => {
    const stdin = JSON.stringify({ session_id: "from-stdin" });
    const result = runHook(
      baseCtx({
        args: { agent: "claude", event: "stop", "session-id": "from-flag" },
        stdin,
      }),
    );
    expect(readDropFile(result.filePath).sessionId).toBe("from-flag");
  });

  it("falls back to env LOTUS_SESSION_ID when no flag/payload", () => {
    const result = runHook(
      baseCtx({ env: { LOTUS_SESSION_ID: "env-sess" } }),
    );
    expect(readDropFile(result.filePath).sessionId).toBe("env-sess");
  });

  it("propagates LOTUS_AGENT_PID env var into agentPid field", () => {
    const result = runHook(baseCtx({ env: { LOTUS_AGENT_PID: "12345" } }));
    expect(readDropFile(result.filePath).agentPid).toBe(12345);
  });

  it("custom title via flag overrides default for the event", () => {
    const result = runHook(
      baseCtx({ args: { agent: "claude", event: "stop", title: "Custom title" } }),
    );
    expect(readDropFile(result.filePath).title).toBe("Custom title");
  });
});

describe("runHook — what the operator typed", () => {
  // `UserPromptSubmit`, wired 2026-08-08. Before it, nothing in Claude's payloads carried
  // the operator's words to a consumer: `Stop` sends `last_assistant_message` and the tool
  // events send neither, so the phone's Chat inferred the prompt from a field that rides
  // at most once per turn and landed it under the reply it had caused.
  const submitted = (prompt) =>
    baseCtx({
      args: { agent: "claude", event: "prompt-submit" },
      stdin: JSON.stringify({ session_id: "s-1", prompt }),
    });

  it("puts the prompt in body, where a consumer reads a message from", () => {
    const payload = readDropFile(runHook(submitted("Buatkan pantun")).filePath);

    // `prompt` is deliberately disjoint from BODY_KEYS, so the generic extractor returns
    // nothing here and the entry would otherwise carry no message at all.
    expect(payload.body).toBe("Buatkan pantun");
    expect(payload.event).toBe("prompt-submit");
  });

  it("names the speaker, because this body is not the agent's words", () => {
    expect(readDropFile(runHook(submitted("run the tests")).filePath).title).toBe("You");
  });

  it("stays running, so codespace does not read a turn starting as a turn ending", () => {
    // That stream is filtered on status alone: `idle` there means "the agent completed".
    expect(readDropFile(runHook(submitted("hi")).filePath).status).toBe("running");
  });

  it("carries no tool target — a prompt is not a tool call", () => {
    expect(readDropFile(runHook(submitted("hi")).filePath).toolTarget).toBe("");
  });
});

describe("runHook — event mapping integration", () => {
  it("notification event yields needs-input status", () => {
    const result = runHook(
      baseCtx({ args: { agent: "claude", event: "notification" } }),
    );
    const payload = readDropFile(result.filePath);
    expect(payload.status).toBe("needs-input");
    expect(payload.title).toBe("Needs input");
  });

  // Claude's `Notification` hook carries two unrelated events. The permission request is
  // the one this product exists for; the 60s idle timer is not, and mapping both to
  // `needs-input` put a permission card on the phone and rang it a minute after every
  // reply. Verified against a live host 2026-08-07 — see the comment in run-hook.mjs.
  it("drops the 60s idle-timer notification instead of writing a needs-input drop", () => {
    const result = runHook(
      baseCtx({
        args: { agent: "claude", event: "notification" },
        stdin: JSON.stringify({ message: "Claude is waiting for your input" }),
      }),
    );
    expect(result.outcome).toBe("skipped-idle");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("keeps needs-input for any other notification text, so a real request can never be swallowed", () => {
    // The demotion is deliberately one exact string. This repo has never captured the
    // wording of a real permission notification, so anything unrecognised must alert.
    const result = runHook(
      baseCtx({
        args: { agent: "claude", event: "notification" },
        stdin: JSON.stringify({ message: "Claude needs your permission to use Bash" }),
      }),
    );
    expect(result.outcome).toBe("ok");
    expect(readDropFile(result.filePath).status).toBe("needs-input");
  });

  // Claude 2.1.329 types its notifications; only four of its 14 types wait on the operator.
  it("uses Claude's notification_type: informational types are dropped, asking types kept", () => {
    for (const type of ["idle_prompt", "agent_completed", "agent_needs_input", "push_notification", "auth_success"]) {
      const result = runHook(
        baseCtx({
          args: { agent: "claude", event: "notification" },
          stdin: JSON.stringify({ message: "anything", notification_type: type }),
        }),
      );
      expect(result.outcome).toBe("skipped-idle");
    }
    expect(fs.readdirSync(dir)).toEqual([]);
    for (const type of ["permission_prompt", "worker_permission_prompt", "elicitation_dialog", "elicitation_url_dialog"]) {
      const result = runHook(
        baseCtx({
          args: { agent: "claude", event: "notification" },
          stdin: JSON.stringify({ message: "Claude needs your permission to use Bash", notification_type: type }),
        }),
      );
      expect(readDropFile(result.filePath).status).toBe("needs-input");
    }
  });

  it("does not demote on a substring — the phrase can appear inside a real prompt", () => {
    const result = runHook(
      baseCtx({
        args: { agent: "claude", event: "notification" },
        stdin: JSON.stringify({
          message: "Claude is waiting for your input on whether to delete build/",
        }),
      }),
    );
    expect(result.outcome).toBe("ok");
    expect(readDropFile(result.filePath).status).toBe("needs-input");
  });

  it("demotes only the notification event — a stop carrying that text is still a turn", () => {
    const result = runHook(
      baseCtx({
        args: { agent: "claude", event: "stop" },
        stdin: JSON.stringify({ message: "Claude is waiting for your input" }),
      }),
    );
    expect(result.outcome).toBe("ok");
    expect(readDropFile(result.filePath).status).toBe("idle");
  });

  it("error event yields error status", () => {
    const result = runHook(
      baseCtx({ args: { agent: "claude", event: "error" } }),
    );
    expect(readDropFile(result.filePath).status).toBe("error");
  });

  it("session-end event yields ended status", () => {
    const result = runHook(
      baseCtx({ args: { agent: "claude", event: "session-end" } }),
    );
    expect(readDropFile(result.filePath).status).toBe("ended");
  });
});

describe("runHook — guards", () => {
  it("skips when both agent and event are missing (would create phantom drop)", () => {
    const result = runHook(baseCtx({ args: {} }));
    expect(result.outcome).toBe("skipped-empty");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("does not skip when only event is given (agent defaults to unknown)", () => {
    const result = runHook(baseCtx({ args: { event: "stop" } }));
    expect(result.outcome).toBe("ok");
  });

  it("skips write when drop dir exceeds soft cap", () => {
    for (let i = 0; i < DROP_DIR_SOFT_CAP; i += 1) {
      fs.writeFileSync(path.join(dir, `existing-${i}.json`), "{}");
    }
    const result = runHook(baseCtx());
    expect(result.outcome).toBe("skipped-full");
  });

  it("returns write-failed when target dir is unwritable", () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "");
    const result = runHook(baseCtx({ dropDir: blocker })); // file used as dir → fails mkdir
    expect(result.outcome).toBe("write-failed");
  });
});

describe("runHook — burst writes", () => {
  it("50 invocations produce 50 distinct files (no collision)", () => {
    for (let i = 0; i < 50; i += 1) {
      const result = runHook(
        baseCtx({
          timestamp: 1714000000000 + i,
          randomSuffix: `r${i.toString(16).padStart(5, "0")}`,
        }),
      );
      expect(result.outcome).toBe("ok");
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(50);
    expect(new Set(files).size).toBe(50);
  });
});

describe("runHook — robustness", () => {
  it("invalid JSON in stdin does not crash; falls through to defaults", () => {
    const result = runHook(baseCtx({ stdin: "not json {" }));
    expect(result.outcome).toBe("ok");
    const payload = readDropFile(result.filePath);
    expect(payload.body).toBe("");
    expect(payload.userPrompt).toBe("");
  });

  it("hard-truncates oversized body and userPrompt", () => {
    const stdin = JSON.stringify({
      body: "B".repeat(20_000),
      prompt: "P".repeat(10_000),
    });
    const result = runHook(baseCtx({ stdin }));
    const payload = readDropFile(result.filePath);
    expect(payload.body.length).toBe(8000);
    expect(payload.userPrompt.length).toBe(4000);
    // Hard still means hard — no ellipsis byte. What changed is that the cut is
    // now reported rather than silent.
    expect(payload.body.endsWith("B")).toBe(true);
    expect(payload.bodyTruncated).toBe(true);
  });
});

describe("runHook — narration tool events", () => {
  it("titles a tool drop with the tool name from the hook payload", () => {
    // The consumer derives its routing tag from `title`, so the tool name has to survive the trip
    // without any new schema field.
    const result = runHook(
      baseCtx({
        args: { agent: "claude", event: "tool-pre" },
        stdin: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: "/repo/auth.ts" } }),
      }),
    );

    expect(readDropFile(result.filePath).title).toBe("Edit");
  });

  it("keeps a tool drop at running status so it never reads as agent completion", () => {
    const result = runHook(
      baseCtx({ args: { agent: "claude", event: "tool-post" }, stdin: JSON.stringify({ tool_name: "Bash" }) }),
    );

    expect(readDropFile(result.filePath).status).toBe("running");
  });

  it("leaves a non-tool hook on its own title even when the payload mentions a tool", () => {
    // A Stop hook's stdin can carry the last tool call. Letting that win would retitle the
    // turn-end drop as if it were a tool event.
    const result = runHook(baseCtx({ args: { agent: "claude", event: "stop" }, stdin: JSON.stringify({ tool_name: "Edit" }) }));

    expect(readDropFile(result.filePath).title).toBe("Finished working");
  });

  it("still lets an explicit --title flag win over the extracted tool name", () => {
    const result = runHook(
      baseCtx({
        args: { agent: "claude", event: "tool-pre", title: "Custom" },
        stdin: JSON.stringify({ tool_name: "Edit" }),
      }),
    );

    expect(readDropFile(result.filePath).title).toBe("Custom");
  });
});

describe("runHook — tool target", () => {
  // The end-to-end claim: what PreToolUse sends on stdin reaches the drop file as
  // a line a phone can render, without the consumer knowing Bash's schema.
  it("carries the command from a PreToolUse payload", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "rm src/legacy/shim.ts" },
    });

    const result = runHook(baseCtx({ args: { agent: "claude", event: "tool-pre" }, stdin }));

    expect(readDropFile(result.filePath)).toMatchObject({
      title: "Bash",
      toolTarget: "rm src/legacy/shim.ts",
    });
  });

  it("carries the file path for an edit", () => {
    const stdin = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "src/app.ts" },
    });

    const result = runHook(baseCtx({ args: { agent: "claude", event: "tool-post" }, stdin }));

    expect(readDropFile(result.filePath).toolTarget).toBe("src/app.ts");
  });

  // A Stop hook's stdin can still describe the last tool call. Letting that
  // through would attach a stale argument to a turn-end drop, which reads as if
  // the agent is still working on it.
  it("ignores a tool payload on a non-tool event", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "rm -rf node_modules" },
      last_assistant_message: "All done.",
    });

    const result = runHook(baseCtx({ args: { agent: "claude", event: "stop" }, stdin }));

    const payload = readDropFile(result.filePath);
    expect(payload.toolTarget).toBe("");
    expect(payload.title).toBe("Finished working");
  });
});

describe("runHook — failed tool result", () => {
  // Failure rides the event name, never the status: the codespace consumer filters
  // on status alone and reads "error" as "the agent failed", which would mislabel a
  // whole agent over one bad tool call.
  it("renames tool-post to tool-post-failed and keeps status running", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "false" },
      tool_response: { exit_code: 1 },
    });

    const result = runHook(baseCtx({ args: { agent: "claude", event: "tool-post" }, stdin }));

    const payload = readDropFile(result.filePath);
    expect(payload.event).toBe("tool-post-failed");
    expect(payload.status).toBe("running");
  });

  it("leaves a successful call as tool-post", () => {
    const stdin = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "true" },
      tool_response: { stdout: "", stderr: "", interrupted: false },
    });

    const result = runHook(baseCtx({ args: { agent: "claude", event: "tool-post" }, stdin }));

    expect(readDropFile(result.filePath).event).toBe("tool-post");
  });

  // A pre-event has no result to judge, so it must never be renamed even if the
  // stdin happens to carry a stale tool_response.
  it("never renames a pre event", () => {
    const stdin = JSON.stringify({ tool_name: "Bash", tool_response: { exit_code: 1 } });

    const result = runHook(baseCtx({ args: { agent: "claude", event: "tool-pre" }, stdin }));

    expect(readDropFile(result.filePath).event).toBe("tool-pre");
  });

  it("still carries the target and diff stat on a failed call", () => {
    const stdin = JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: "src/app.ts" },
      tool_response: { error: "no match", structuredPatch: [{ lines: ["-a", "+b"] }] },
    });

    const result = runHook(baseCtx({ args: { agent: "claude", event: "tool-post" }, stdin }));

    const payload = readDropFile(result.filePath);
    expect(payload.event).toBe("tool-post-failed");
    expect(payload.toolTarget).toBe("src/app.ts");
    expect(payload.linesAdded).toBe(1);
  });
});

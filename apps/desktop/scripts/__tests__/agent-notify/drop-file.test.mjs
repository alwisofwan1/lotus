import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveDropDir,
  slug,
  truncate,
  buildDropPayload,
  buildDropFilename,
  writeDropFileAtomic,
  countFilesAtMost,
} from "../../agent-notify/drop-file.mjs";

describe("slug", () => {
  it("keeps alphanumerics and hyphens, drops everything else", () => {
    expect(slug("Hello World!", 32)).toBe("HelloWorld");
    expect(slug("foo/bar.baz", 32)).toBe("foobarbaz");
    expect(slug("abc-123-DEF", 32)).toBe("abc-123-DEF");
  });

  it("truncates to max length", () => {
    expect(slug("aaaaaaaaaaaaaaaaaaaa", 5)).toBe("aaaaa");
  });

  it("returns 'unknown' on empty/falsy input", () => {
    expect(slug("", 32)).toBe("unknown");
    expect(slug(null, 32)).toBe("unknown");
    expect(slug(undefined, 32)).toBe("unknown");
    expect(slug("!!!", 32)).toBe("unknown");
  });

  it("defaults max to 32 when not provided", () => {
    const long = "a".repeat(100);
    expect(slug(long).length).toBe(32);
  });
});

describe("truncate", () => {
  it("returns string unchanged when shorter than max", () => {
    expect(truncate("hello", 100)).toBe("hello");
  });

  it("hard-cuts at max", () => {
    expect(truncate("hello world", 5)).toBe("hello");
  });

  it("coerces non-strings to empty", () => {
    expect(truncate(null, 10)).toBe("");
    expect(truncate(undefined, 10)).toBe("");
    expect(truncate(123, 10)).toBe("123");
  });
});

describe("buildDropPayload", () => {
  it("produces a v1 payload with all expected fields", () => {
    const payload = buildDropPayload({
      sessionId: "abc",
      agent: "claude",
      event: "stop",
      status: "idle",
      title: "Finished working",
      body: "Done.",
      userPrompt: "do it",
      cwd: "/tmp/proj",
      pid: 42,
      agentPid: 50,
      paneId: "node-atlas-1",
      timestamp: 1714000000000,
    });

    expect(payload).toEqual({
      version: 1,
      sessionId: "abc",
      agentType: "claude",
      event: "stop",
      status: "idle",
      title: "Finished working",
      body: "Done.",
      // Present on every payload, false when the body fit. Like `toolTarget` below,
      // leaving it out of this literal fails the assertion — which is the guard
      // working, because the on-disk shape is a contract the Rust watcher reads.
      bodyTruncated: false,
      userPrompt: "do it",
      // Present on every payload, empty when the hook did not say where the agent CLI
      // keeps its own conversation. Fase 3 reads that file for history the drop ring
      // cannot hold; leaving it out of this literal fails the assertion, which is the
      // guard working.
      transcriptPath: "",
      // Present on every payload, empty for non-tool events. Absent from this
      // literal would make the assertion fail, which is the guard working: the
      // on-disk shape is a contract the Rust watcher and the fixtures both read.
      toolTarget: "",
      linesAdded: null,
      linesRemoved: null,
      cwd: "/tmp/proj",
      pid: 42,
      agentPid: 50,
      paneId: "node-atlas-1",
      timestamp: 1714000000000,
    });
  });

  it("defaults missing fields to safe values", () => {
    const payload = buildDropPayload({
      agent: "claude",
      event: "stop",
      status: "idle",
      title: "",
      timestamp: 1,
    });
    expect(payload.sessionId).toBeNull();
    expect(payload.body).toBe("");
    expect(payload.userPrompt).toBe("");
    expect(payload.cwd).toBe("");
    expect(payload.pid).toBeNull();
    expect(payload.agentPid).toBeNull();
  });

  it("truncates oversized strings to spec caps", () => {
    const payload = buildDropPayload({
      agent: "claude",
      event: "stop",
      status: "idle",
      title: "x".repeat(500),
      body: "y".repeat(20_000),
      userPrompt: "z".repeat(10_000),
      timestamp: 1,
    });
    expect(payload.title.length).toBe(200);
    expect(payload.body.length).toBe(8000);
    expect(payload.userPrompt.length).toBe(4000);
  });

  // A clipped assistant message that does not announce itself reads as a finished
  // one. Measured 2026-08-07: at the old 1000-char cap, 15.8% of real replies were
  // being cut this way, silently.
  it("says so when it cut the body", () => {
    const payload = buildDropPayload({
      agent: "claude",
      event: "stop",
      status: "idle",
      body: "y".repeat(20_000),
      timestamp: 1,
    });
    expect(payload.bodyTruncated).toBe(true);
  });

  it("does not claim truncation for a body that fits", () => {
    const payload = buildDropPayload({
      agent: "claude",
      event: "stop",
      status: "idle",
      body: "Done. The migration script is ready.",
      timestamp: 1,
    });
    expect(payload.bodyTruncated).toBe(false);
  });

  // The flag exists because truncation stays hard: the cap is applied again in
  // `agent_hooks/payload.rs`, and that second pass is only safe while clamping is
  // idempotent. An appended ellipsis would have broken it.
  it("leaves no ellipsis byte behind, so re-clamping is a no-op", () => {
    const once = buildDropPayload({
      agent: "claude",
      event: "stop",
      status: "idle",
      body: "y".repeat(20_000),
      timestamp: 1,
    }).body;
    const twice = buildDropPayload({
      agent: "claude",
      event: "stop",
      status: "idle",
      body: once,
      timestamp: 1,
    }).body;

    expect(twice).toBe(once);
    expect(once.endsWith("…")).toBe(false);
  });
});

describe("buildDropFilename", () => {
  it("encodes session id, timestamp, agent, event, and random suffix", () => {
    const name = buildDropFilename({
      sessionId: "abc-123",
      agent: "claude",
      event: "stop",
      timestamp: 1714000000000,
      randomSuffix: "deadbe",
      pid: 999,
    });
    expect(name).toBe("abc-123--1714000000000-claude-stop-deadbe.json");
  });

  it("falls back to nosession-<pid> when sessionId missing", () => {
    const name = buildDropFilename({
      sessionId: null,
      agent: "codex",
      event: "stop",
      timestamp: 7,
      randomSuffix: "abc123",
      pid: 555,
    });
    expect(name).toBe("nosession-555--7-codex-stop-abc123.json");
  });

  it("slugifies all segments to file-system-safe characters", () => {
    const name = buildDropFilename({
      sessionId: "weird/id with spaces",
      agent: "Custom Agent",
      event: "Stop / Done",
      timestamp: 1,
      randomSuffix: "x",
      pid: 1,
    });
    // No slashes, no spaces.
    expect(name).not.toMatch(/[\/ ]/);
    expect(name.endsWith(".json")).toBe(true);
  });
});

describe("countFilesAtMost", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lotus-drop-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns 0 for an empty directory", () => {
    expect(countFilesAtMost(dir, 10)).toBe(0);
  });

  it("counts up to limit and stops early", () => {
    for (let i = 0; i < 20; i += 1) {
      fs.writeFileSync(path.join(dir, `f${i}.json`), "{}");
    }
    expect(countFilesAtMost(dir, 5)).toBe(5);
  });

  it("returns 0 for non-existent directory", () => {
    expect(countFilesAtMost(path.join(dir, "missing"), 10)).toBe(0);
  });
});

describe("writeDropFileAtomic", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lotus-drop-test-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates the file with the JSON-stringified payload", () => {
    const target = path.join(dir, "out.json");
    writeDropFileAtomic(target, { hello: "world" });
    const contents = JSON.parse(fs.readFileSync(target, "utf8"));
    expect(contents).toEqual({ hello: "world" });
  });

  it("creates parent directory if missing", () => {
    const nested = path.join(dir, "a", "b", "c");
    const target = path.join(nested, "out.json");
    writeDropFileAtomic(target, { ok: true });
    expect(fs.existsSync(target)).toBe(true);
  });

  it("does not leave a .tmp file behind on success", () => {
    const target = path.join(dir, "out.json");
    writeDropFileAtomic(target, { ok: true });
    const remnants = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    expect(remnants).toEqual([]);
  });

  it("overwrites an existing target", () => {
    const target = path.join(dir, "out.json");
    fs.writeFileSync(target, "stale");
    writeDropFileAtomic(target, { fresh: 1 });
    const contents = JSON.parse(fs.readFileSync(target, "utf8"));
    expect(contents).toEqual({ fresh: 1 });
  });

  it("returns true on success and false on unwritable target", () => {
    const target = path.join(dir, "ok.json");
    expect(writeDropFileAtomic(target, { a: 1 })).toBe(true);

    // Construct an unwritable parent: a regular file used as a path component.
    const fileAsParent = path.join(dir, "blocker");
    fs.writeFileSync(fileAsParent, "");
    const bad = path.join(fileAsParent, "child.json");
    expect(writeDropFileAtomic(bad, { a: 1 })).toBe(false);
  });
});

describe("toolTarget", () => {
  // Additive with a default rather than a version bump: the consumer has no
  // `deny_unknown_fields`, so a new producer against an old consumer is ignored
  // and an old producer against a new one reads the default. Bumping the version
  // would break both directions instead of neither.
  it("stays version 1, because the field is additive", () => {
    const payload = buildDropPayload({
      agent: "claude",
      event: "tool-pre",
      status: "running",
      toolTarget: "rm src/legacy/shim.ts",
      timestamp: 1,
    });

    expect(payload.version).toBe(1);
    expect(payload.toolTarget).toBe("rm src/legacy/shim.ts");
  });

  it("defaults to empty so non-tool events carry the key without a value", () => {
    const payload = buildDropPayload({
      agent: "claude",
      event: "stop",
      status: "idle",
      timestamp: 1,
    });

    expect(payload.toolTarget).toBe("");
  });

  it("truncates a runaway command rather than blowing the drop file up", () => {
    const payload = buildDropPayload({
      agent: "claude",
      event: "tool-pre",
      status: "running",
      toolTarget: "x".repeat(5000),
      timestamp: 1,
    });

    expect(payload.toolTarget.length).toBeLessThanOrEqual(300);
  });
});

describe("diff stat", () => {
  it("carries the counts when the tool changed lines", () => {
    const payload = buildDropPayload({
      agent: "claude",
      event: "tool-post",
      status: "running",
      linesAdded: 3,
      linesRemoved: 1,
      timestamp: 1,
    });

    expect(payload.linesAdded).toBe(3);
    expect(payload.linesRemoved).toBe(1);
  });

  // Null, not 0: "changed nothing" and "we could not tell" are different claims,
  // and 0 would render as "+0 -0" on a step that has no diff at all.
  it("defaults to null rather than zero", () => {
    const payload = buildDropPayload({
      agent: "claude",
      event: "stop",
      status: "idle",
      timestamp: 1,
    });

    expect(payload.linesAdded).toBeNull();
    expect(payload.linesRemoved).toBeNull();
  });

  it.each([[-1], [1.5], [Number.NaN], ["3"], [null], [undefined]])(
    "refuses %p rather than shipping it",
    (value) => {
      const payload = buildDropPayload({
        agent: "claude",
        event: "tool-post",
        status: "running",
        linesAdded: value,
        timestamp: 1,
      });

      expect(payload.linesAdded).toBeNull();
    },
  );
});

describe("resolveDropDir", () => {
  // The parent has to decide: the same script file is installed to ~/.lotus by a
  // release build and to ~/.lotus-dev by a dev build, and it cannot tell which
  // copy it is. A hardcoded default made both write to the release directory, so
  // two desktops raced for every hook event.
  it("prefers the directory the parent passed", () => {
    expect(resolveDropDir({ "drop-dir": "/Users/x/.lotus-dev/agent-hooks/global" })).toBe(
      "/Users/x/.lotus-dev/agent-hooks/global",
    );
  });

  it("falls back when the parent said nothing", () => {
    expect(resolveDropDir({})).toContain(".lotus/agent-hooks/global");
    expect(resolveDropDir({ "drop-dir": "  " })).toContain(".lotus/agent-hooks/global");
  });

  // A hook runs with the agent's cwd, which is whatever repo the operator was in,
  // so a relative path would scatter drop files across their projects.
  it("refuses a relative path", () => {
    expect(resolveDropDir({ "drop-dir": "./drops" })).toContain(".lotus/agent-hooks/global");
  });
});

describe("buildDropPayload — transcript path", () => {
  it("carries the path through, so a consumer can read the durable history", () => {
    const payload = buildDropPayload({
      agent: "codex",
      event: "stop",
      status: "idle",
      transcriptPath: "/Users/x/.codex/sessions/2026/08/13/rollout-abc.jsonl",
      timestamp: 1,
    });
    expect(payload.transcriptPath).toBe("/Users/x/.codex/sessions/2026/08/13/rollout-abc.jsonl");
  });

  it("clamps a path long enough to be a symptom rather than a session", () => {
    const payload = buildDropPayload({
      agent: "claude",
      event: "stop",
      status: "idle",
      transcriptPath: "/" + "a".repeat(9000),
      timestamp: 1,
    });
    expect(payload.transcriptPath.length).toBe(4096);
  });
});

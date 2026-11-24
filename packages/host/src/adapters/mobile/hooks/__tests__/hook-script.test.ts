import { describe, expect, it, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

import { buildClaudeHookScript, CLAUDE_HOOK_EVENTS, withClaudeHook } from "../hook-script.js";

/**
 * The script is shell, so the tests run it. Asserting on its text would pass for a script that
 * does nothing — and the two properties that matter here are behavioural: it must exit 0 on every
 * path, and it must do nothing at all for a session that is not a Lotus pane.
 */

const SCRIPT = buildClaudeHookScript({ discoveryPath: "/nonexistent/lotus-mcp-ipc.json" });

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Runs the real script under `sh`, without blocking this process — see the listener test. */
function runAsync(
  phase: string,
  env: NodeJS.ProcessEnv,
  script: string,
  stdin = "",
): Promise<number | null> {
  const dir = mkdtempSync(join(tmpdir(), "lotus-hook-"));
  dirs.push(dir);
  const path = join(dir, "hook.sh");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  const child = spawn("sh", [path, phase], { env: { PATH: "/usr/bin:/bin", ...env } });
  // Claude sends its payload on stdin; a script that never reads it hangs nothing, but a test
  // that never closes it would.
  child.stdin.end(stdin);
  return new Promise((resolve) => child.on("exit", resolve));
}

/** Runs the real script under `sh`, the way Claude would. */
function run(phase: string, env: NodeJS.ProcessEnv = {}, script = SCRIPT) {
  const dir = mkdtempSync(join(tmpdir(), "lotus-hook-"));
  dirs.push(dir);
  const path = join(dir, "hook.sh");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  // PATH is emptied so a curl that should never happen cannot silently happen.
  return spawnSync("sh", [path, phase], { env: { PATH: "/usr/bin:/bin", ...env }, encoding: "utf8" });
}

describe("buildClaudeHookScript", () => {
  it("needs no node, because the artifact this host ships as has none", () => {
    expect(SCRIPT).not.toContain("node ");
  });

  /**
   * Registered in the GLOBAL settings file, so it fires in every Claude session on the machine —
   * including ones a person started by hand in their own terminal. It must cost them nothing and
   * say nothing.
   */
  it("does nothing at all for a session that is not a Lotus pane", () => {
    const result = run("notification");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  /**
   * The rule every path here obeys: a `PreToolUse` hook exiting non-zero BLOCKS the tool call.
   * A missing discovery file, an unmapped phase, a host that is not listening — all exit 0.
   */
  it("exits 0 on every path, including ones where nothing works", () => {
    for (const phase of ["notification", "stop", "session-end", "banana", ""]) {
      const result = run(phase, { LOTUS_PANE_ID: "pane-7" });
      expect(result.status, `phase ${phase}`).toBe(0);
      expect(result.stderr, `phase ${phase}`).toBe("");
    }
  });

  it("says nothing when the host has advertised nothing to talk to", () => {
    const result = run("notification", { LOTUS_PANE_ID: "pane-7" });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("reads the port at fire time, not at install time", () => {
    // The port is OS-assigned and changes on every host restart, so a value baked in here would
    // be stale by the next one.
    expect(SCRIPT).not.toMatch(/127\.0\.0\.1:\d+/);
    expect(SCRIPT).toContain("$PORT");
  });
});

/**
 * The whole contract in one test: the shell script a hook fires, against the route this host
 * serves. Either half can be right on its own and still not meet the other — the sed that reads
 * the discovery file, the JSON quoting, the header, the path.
 */
describe("the script against a real listener", () => {
  it("posts the pane and its status to the host", async () => {
    const seen: Array<{ url: string; auth: string; body: string; pane: string; status: string }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += String(c); });
      req.on("end", () => {
        seen.push({
          url: req.url ?? "",
          auth: String(req.headers.authorization ?? ""),
          body,
          pane: String(req.headers["x-lotus-pane-id"] ?? ""),
          status: String(req.headers["x-lotus-status"] ?? ""),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const dir = mkdtempSync(join(tmpdir(), "lotus-ipc-"));
    dirs.push(dir);
    const discovery = join(dir, "lotus-mcp-ipc.json");
    writeFileSync(discovery, JSON.stringify({ port, secret: "s3cret" }, null, 2));

    try {
      // Async, not `spawnSync`: a synchronous spawn blocks this process's event loop, so the
      // listener above could never accept the connection and curl would sit out its own timeout.
      // The first version of this test did exactly that and blamed the script.
      // Claude's own payload, the shape it really writes to a hook's stdin.
      const payload = JSON.stringify({
        session_id: "1f0b-aaaa",
        transcript_path: "/home/alwi/.claude/projects/-p/1f0b.jsonl",
        cwd: "/home/alwi/p",
        hook_event_name: "Notification",
      });
      const code = await runAsync(
        "notification",
        { LOTUS_PANE_ID: "pane-7" },
        buildClaudeHookScript({ discoveryPath: discovery }),
        payload,
      );

      expect(code).toBe(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toBe("/v1/hook/turn");
      expect(seen[0]?.auth).toBe("Bearer s3cret");
      // Lotus's two facts in headers, the CLI's payload untouched in the body. Nothing about it
      // is re-encoded in `sh`, which is where this project has already lost two escaping bugs.
      expect(seen[0]?.pane).toBe("pane-7");
      expect(seen[0]?.status).toBe("needs-input");
      expect(seen[0]?.body).toBe(payload);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("withClaudeHook", () => {
  const PATH = "/home/op/.lotus/claude-hook.sh";
  /** Claude's own shape, copied from a real `~/.claude/settings.json`. */
  const entry = (command: string) => ({ hooks: [{ type: "command", command }] });

  /**
   * The phase rides in the command string. Claude does not pass the event name as an argument —
   * it sends JSON on stdin — so a bare script left `$1` empty and every fire fell through the
   * `case` to `exit 0`. Measured against a live prompt on devbox-vps 2026-09-06.
   */
  it("names the phase in the command, because Claude will not", () => {
    const merged = withClaudeHook({}, PATH, { Notification: "notification", Stop: "stop" });

    expect(merged["hooks"]).toEqual({
      Notification: [entry(`${PATH} notification`)],
      Stop: [entry(`${PATH} stop`)],
    });
  });

  /**
   * A flat `{ command }` was written into a real settings file on 2026-09-06. It sat there
   * looking installed and Claude never fired it — the same silent success this project keeps
   * meeting. The shape is Claude's, not ours.
   */
  it("writes the shape Claude actually reads", () => {
    const merged = withClaudeHook({}, PATH, { Notification: "notification" });

    expect((merged["hooks"] as any).Notification[0]).toEqual({
      hooks: [{ type: "command", command: `${PATH} notification` }],
    });
  });

  /**
   * The file is the operator's, shared with every other tool that registers hooks. Touching
   * somebody else's entry is how a person loses a hook they depend on and never finds out why.
   */
  it("leaves every other key, event and command exactly as it found them", () => {
    // Verbatim shapes from a real settings file, including a matcher.
    const before = {
      model: "opus",
      hooks: {
        Notification: [{ hooks: [{ type: "command", command: "/somebody/else.sh" }] }],
        PreToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: "/another/tool.sh" }] }],
      },
    };

    const merged = withClaudeHook(before, PATH, { Notification: "notification" });

    expect(merged["model"]).toBe("opus");
    expect((merged["hooks"] as any).PreToolUse).toEqual([
      { matcher: "Write|Edit", hooks: [{ type: "command", command: "/another/tool.sh" }] },
    ]);
    expect((merged["hooks"] as any).Notification).toEqual([
      { hooks: [{ type: "command", command: "/somebody/else.sh" }] },
      entry(`${PATH} notification`),
    ]);
  });

  /** Re-running an install must refresh its own entry, never stack a second copy. */
  it("is idempotent", () => {
    const once = withClaudeHook({}, PATH, { Stop: "stop" });
    const twice = withClaudeHook(once, PATH, { Stop: "stop" });

    expect((twice["hooks"] as any).Stop).toEqual([entry(`${PATH} stop`)]);
  });

  /** Including across an upgrade that changes the phase a hook is registered with. */
  it("replaces its own entry even when the phase changed", () => {
    const before = withClaudeHook({}, PATH, { Stop: "stop" });

    const after = withClaudeHook(before, PATH, { Stop: "agent-response" });

    expect((after["hooks"] as any).Stop).toEqual([entry(`${PATH} agent-response`)]);
  });

  it("survives a settings file whose hooks are the wrong shape", () => {
    const merged = withClaudeHook({ hooks: "not an object" }, PATH, { Stop: "stop" });

    expect((merged["hooks"] as any).Stop).toEqual([entry(`${PATH} stop`)]);
  });

  /** Including the flat entries an earlier version of this host wrote into real files. */
  it("replaces the flat entry it used to write, rather than leaving a dead one behind", () => {
    const before = { hooks: { Stop: [{ command: `${PATH} stop` }] } };

    const merged = withClaudeHook(before, PATH, { Stop: "stop" });

    expect((merged["hooks"] as any).Stop).toEqual([entry(`${PATH} stop`)]);
  });

  it("survives an event whose value is not a list", () => {
    const merged = withClaudeHook({ hooks: { Stop: { command: "odd" } } }, PATH, { Stop: "stop" });

    expect((merged["hooks"] as any).Stop).toEqual([entry(`${PATH} stop`)]);
  });
});

/**
 * Slice 3.6. Every fire is what tells the host to publish a pane's new steps, so which events are
 * registered decides whether Chat moves while an agent works or fills in at the end.
 */
describe("firing often enough for Chat to move", () => {
  it("fires on each completed tool step, not only at the ends of a turn", () => {
    expect(Object.keys(CLAUDE_HOOK_EVENTS)).toContain("PostToolUse");
  });

  it("calls a completed tool step running, because the turn is not over", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(String(req.headers["x-lotus-status"] ?? ""));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const dir = mkdtempSync(join(tmpdir(), "lotus-ipc-"));
    dirs.push(dir);
    const discovery = join(dir, "lotus-mcp-ipc.json");
    writeFileSync(discovery, JSON.stringify({ port, secret: "s3cret" }));

    try {
      const code = await runAsync(
        CLAUDE_HOOK_EVENTS["PostToolUse"] ?? "",
        { LOTUS_PANE_ID: "pane-7" },
        buildClaudeHookScript({ discoveryPath: discovery }),
        "{}",
      );

      expect(code).toBe(0);
      expect(seen).toEqual(["running"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

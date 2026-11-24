// End-to-end test: spawn `node scripts/agent-notify/index.mjs` as a real
// subprocess, with stdin piped + flags, and assert a drop file lands.
//
// Verifies the production wiring: shebang, exit code, atomic write, never
// crashes on malformed input.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENTRY = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../agent-notify/index.mjs",
);

let dropDirOverride;

beforeEach(() => {
  dropDirOverride = fs.mkdtempSync(path.join(os.tmpdir(), "lotus-spawn-"));
});

afterEach(() => {
  fs.rmSync(dropDirOverride, { recursive: true, force: true });
});

/**
 * Spawn the script. We override `HOME` so `defaultDropDir()` resolves into
 * our temp dir; the script writes to `<HOME>/.lotus/agent-hooks/global/`.
 */
function spawnScript({ args = [], stdin = "", env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [ENTRY, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: dropDirOverride,
        USERPROFILE: dropDirOverride,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

function readSingleDropFile() {
  const globalDir = path.join(dropDirOverride, ".lotus", "agent-hooks", "global");
  if (!fs.existsSync(globalDir)) return null;
  const files = fs.readdirSync(globalDir).filter((f) => f.endsWith(".json"));
  if (files.length !== 1) return null;
  return JSON.parse(fs.readFileSync(path.join(globalDir, files[0]), "utf8"));
}

describe("agent-notify index.mjs (subprocess)", { timeout: 10_000 }, () => {
  it("exits 0 and writes a drop file for a Claude Stop hook", async () => {
    const stdin = JSON.stringify({
      session_id: "spawn-sess",
      last_assistant_message: "All done.",
      prompt: "implement feature X",
    });

    const { code } = await spawnScript({
      args: ["--agent", "claude", "--event", "stop"],
      stdin,
    });

    expect(code).toBe(0);
    const payload = readSingleDropFile();
    expect(payload).toMatchObject({
      version: 1,
      agentType: "claude",
      event: "stop",
      status: "idle",
      title: "Finished working",
      sessionId: "spawn-sess",
      body: "All done.",
      userPrompt: "implement feature X",
    });
  });

  it("exits 0 with no stdin (still writes via flags only)", async () => {
    const { code } = await spawnScript({
      args: [
        "--agent", "custom",
        "--event", "stop",
        "--session-id", "manual-1",
        "--body", "manual body",
      ],
    });
    expect(code).toBe(0);
    const payload = readSingleDropFile();
    expect(payload?.sessionId).toBe("manual-1");
    expect(payload?.body).toBe("manual body");
  });

  it("exits 0 even when stdin is malformed JSON", async () => {
    const { code } = await spawnScript({
      args: ["--agent", "claude", "--event", "stop"],
      stdin: "this is not valid json {{",
    });
    expect(code).toBe(0);
    const payload = readSingleDropFile();
    expect(payload?.body).toBe("");
    expect(payload?.userPrompt).toBe("");
  });

  it("exits 0 with no flags and no stdin (skips write but does not error)", async () => {
    const { code } = await spawnScript({});
    expect(code).toBe(0);
    expect(readSingleDropFile()).toBeNull();
  });

  it("propagates LOTUS_AGENT_PID env var", async () => {
    const { code } = await spawnScript({
      args: ["--agent", "claude", "--event", "stop"],
      env: { LOTUS_AGENT_PID: "7777" },
    });
    expect(code).toBe(0);
    expect(readSingleDropFile()?.agentPid).toBe(7777);
  });
});

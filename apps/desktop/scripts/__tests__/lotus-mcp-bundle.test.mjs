import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("lotus-mcp-server.bundle.mjs", () => {
  it("starts with node from an arbitrary cwd without repo node_modules", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lotus-mcp-cwd-"));
    const discovery = join(cwd, "lotus-mcp-ipc.json");
    await writeFile(discovery, JSON.stringify({ version: 1, port: 9, secret: "x".repeat(64), pid: 1 }));

    const child = spawn(
      process.execPath,
      [join(process.cwd(), "scripts", "lotus-mcp-server.bundle.mjs"), "--discovery", discovery],
      { cwd, stdio: ["pipe", "pipe", "pipe"] },
    );

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    await sleep(500);
    const exitedEarly = child.exitCode !== null;
    child.kill("SIGTERM");

    expect(stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(stderr).not.toContain("z.looseObject is not a function");
    expect(exitedEarly, stderr).toBe(false);
  });

  it("is rebuilt from the source — every tool the source declares is in the bundle", async () => {
    // Rust embeds the BUNDLE (include_str! in mcp_config.rs), not the source. `tauri dev` rebuilds
    // Rust on a file change without re-running `mcp:bundle`, so a tool added to the source alone
    // reaches no agent — and the agent falls back to curling the app. Run `bun run mcp:bundle`.
    const toolNames = (text) => new Set([...text.matchAll(/^\s*name: "(lotus_[a-z_]+)",$/gm)].map((m) => m[1]));
    const source = toolNames(await readFile(join(process.cwd(), "scripts", "lotus-mcp-server.mjs"), "utf8"));
    const bundle = toolNames(await readFile(join(process.cwd(), "scripts", "lotus-mcp-server.bundle.mjs"), "utf8"));
    expect(source.size).toBeGreaterThan(10);
    const missing = [...source].filter((name) => !bundle.has(name));
    expect(missing, "stale bundle — run `bun run mcp:bundle`").toEqual([]);
  });
});

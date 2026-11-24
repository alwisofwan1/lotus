import { describe, expect, it, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installClaudeHook, HOOK_SCRIPT_NAME } from "../install.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "lotus-install-"));
  dirs.push(root);
  const stateDir = join(root, ".lotus");
  const settingsPath = join(root, ".claude", "settings.json");
  return {
    root,
    stateDir,
    settingsPath,
    install: () => installClaudeHook({ stateDir, discoveryPath: join(stateDir, "ipc.json"), settingsPath }),
    settings: () => JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, any>,
  };
}

describe("installClaudeHook", () => {
  it("writes an executable script and names it in the settings file", () => {
    const w = workspace();

    const installed = w.install();

    expect(installed?.scriptPath).toBe(join(w.stateDir, HOOK_SCRIPT_NAME));
    // 0755: Claude runs it directly, not through an interpreter it picks.
    expect(statSync(installed!.scriptPath).mode & 0o777).toBe(0o755);
    // The phase rides in the command — Claude does not pass the event name as an argument.
    expect(w.settings()["hooks"]["Notification"]).toEqual([
      { hooks: [{ type: "command", command: `${installed!.scriptPath} notification` }] },
    ]);
  });

  /** Re-run on every start, so a fix to the script body ships without the operator doing anything. */
  it("is idempotent, and refreshes the script body", () => {
    const w = workspace();
    w.install();
    writeFileSync(join(w.stateDir, HOOK_SCRIPT_NAME), "#!/bin/sh\n# stale\n");

    const again = w.install();

    expect(readFileSync(again!.scriptPath, "utf8")).toContain("LOTUS_PANE_ID");
    expect(w.settings()["hooks"]["Stop"]).toEqual([
      { hooks: [{ type: "command", command: `${again!.scriptPath} stop` }] },
    ]);
  });

  it("keeps what the operator and other tools already put there", () => {
    const w = workspace();
    mkdirSync(join(w.root, ".claude"), { recursive: true });
    writeFileSync(w.settingsPath, JSON.stringify({
      model: "opus",
      hooks: {
        Notification: [{ hooks: [{ type: "command", command: "/somebody/else.sh" }] }],
        PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "/x.sh" }] }],
      },
    }));

    const installed = w.install();

    const settings = w.settings();
    expect(settings["model"]).toBe("opus");
    expect(settings["hooks"]["PreToolUse"]).toEqual([
      { matcher: "Write", hooks: [{ type: "command", command: "/x.sh" }] },
    ]);
    expect(settings["hooks"]["Notification"]).toEqual([
      { hooks: [{ type: "command", command: "/somebody/else.sh" }] },
      { hooks: [{ type: "command", command: `${installed!.scriptPath} notification` }] },
    ]);
  });

  /**
   * The file is the operator's, shared with every other tool that registers hooks. Rewriting one
   * this host cannot parse would destroy entries it cannot see — so it refuses and says so.
   */
  it("refuses to rewrite a settings file it cannot read", () => {
    const w = workspace();
    mkdirSync(join(w.root, ".claude"), { recursive: true });
    writeFileSync(w.settingsPath, "{ not json");
    const warnings: string[] = [];

    const installed = installClaudeHook({
      stateDir: w.stateDir,
      discoveryPath: "/x/ipc.json",
      settingsPath: w.settingsPath,
      logger: { warn: (event: string) => warnings.push(event) } as never,
    });

    expect(installed).toBeUndefined();
    expect(readFileSync(w.settingsPath, "utf8")).toBe("{ not json");
    expect(warnings).toContain("hooks.settings_unreadable");
  });

  it("treats a settings file that is not an object as no settings at all", () => {
    const w = workspace();
    mkdirSync(join(w.root, ".claude"), { recursive: true });
    writeFileSync(w.settingsPath, "[1,2,3]");

    expect(w.install()).toBeDefined();
    expect(w.settings()["hooks"]["Stop"]).toHaveLength(1);
  });

  /**
   * Hooks are one capability. A host that refuses to boot because it could not write a settings
   * file is worse than one that starts without TUI permission and says so through `hostCaps`.
   */
  it("gives up quietly when it cannot write the script at all", () => {
    const w = workspace();
    mkdirSync(w.stateDir, { recursive: true });
    // A directory where the script should go: writing it can only fail.
    mkdirSync(join(w.stateDir, HOOK_SCRIPT_NAME), { recursive: true });
    const warnings: string[] = [];

    const installed = installClaudeHook({
      stateDir: w.stateDir,
      discoveryPath: "/x/ipc.json",
      settingsPath: w.settingsPath,
      logger: { warn: (event: string) => warnings.push(event) } as never,
    });

    expect(installed).toBeUndefined();
    expect(warnings).toContain("hooks.script_unwritable");
  });
});

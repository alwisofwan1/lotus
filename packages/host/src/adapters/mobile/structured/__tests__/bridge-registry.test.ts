import { describe, expect, it } from "vitest";

import { BridgeRegistry } from "../bridge-registry.js";
import { codexBridge, codexOnPath } from "../bridges/codex.js";

/** A PATH that contains this repo's `node_modules/.bin`, which exists — but never a `codex`. */
const emptyPath: NodeJS.ProcessEnv = { PATH: "" };

describe("BridgeRegistry", () => {
  it("knows every bridge, installed or not", () => {
    const registry = new BridgeRegistry({ env: emptyPath });
    expect(registry.all().map((f) => f.agentType)).toEqual(["claude", "codex", "cursor"]);
  });

  it("reports Claude as asking, except in the one mode that cannot", () => {
    // Since Fase 3b the runner really does wait, on an MCP tool the session starts beside
    // it. `bypassPermissions` is the stop where nothing is ever asked.
    const claude = new BridgeRegistry().all().find((f) => f.agentType === "claude");
    expect(claude?.gating("manual")).toBe("asks");
    expect(claude?.gating("read-only")).toBe("asks");
    expect(claude?.gating(undefined)).toBe("asks");
    expect(claude?.gating("full-access")).toBe("skipped");
    expect(claude?.runnerLabel).toBe("Claude Code");
  });

  it("reports an ACP agent as never asking, because it does not", () => {
    // Probed 2026-09-06: cursor-agent over ACP ran `rm -f` and a network call with no request.
    const cursor = new BridgeRegistry().all().find((f) => f.agentType === "cursor");
    expect(cursor?.gating("read-only")).toBe("skipped");
    expect(cursor?.gating(undefined)).toBe("skipped");
    expect(cursor?.runnerLabel).toBe("Cursor");
  });

  it("threads the ACP session seam through too", () => {
    const seen: string[] = [];
    const registry = new BridgeRegistry({
      createAcpSession: (opts) => {
        seen.push(`${opts.agent.command} ${opts.paneId} ${opts.permissionMode ?? "-"}`);
        return fakeSession();
      },
    });
    registry.all().find((f) => f.agentType === "cursor")?.create({
      paneId: "ss-9",
      cwd: "/tmp",
      permissionMode: "read-only",
    });
    expect(seen).toEqual(["cursor-agent ss-9 read-only"]);
  });

  it("hides a runner whose binary is missing, and refuses to find it", () => {
    const registry = new BridgeRegistry({ env: emptyPath });
    expect(registry.available()).toEqual([]);
    expect(registry.find("codex")).toBeUndefined();
    expect(registry.anyAvailable()).toBe(false);
  });

  it("offers a runner whose binary is here", () => {
    // The probe is the unit under test elsewhere; here it only decides which branch to assert.
    const registry = new BridgeRegistry();
    expect(registry.anyAvailable()).toBe(codexOnPath());
    expect(registry.find("codex") === undefined).toBe(!codexOnPath());
  });

  it("threads the session seam through to the factory it builds", () => {
    const seen: string[] = [];
    const registry = new BridgeRegistry({
      createCodexSession: (opts) => {
        seen.push(`${opts.paneId} ${opts.approvalPolicy} ${opts.sandbox}`);
        return fakeSession();
      },
    });
    registry.all().find((f) => f.agentType === "codex")?.create({
      paneId: "ss-1",
      cwd: "/tmp",
      permissionMode: "read-only",
    });
    expect(seen).toEqual(["ss-1 on-request read-only"]);
  });
});

describe("codexBridge", () => {
  it("names itself the way the fleet keys on it", () => {
    const bridge = codexBridge(() => fakeSession());
    expect(bridge.agentType).toBe("codex");
    expect(bridge.runnerLabel).toBe("Codex");
  });

  it("reads gating from the posture, not from the word", () => {
    const bridge = codexBridge(() => fakeSession());
    expect(bridge.gating("yolo")).toBe("skipped");
    expect(bridge.gating("full-access")).toBe("skipped");
    expect(bridge.gating("read-only")).toBe("asks");
    // An unknown stop is read as *ask*, never as *run free*.
    expect(bridge.gating("something-newer")).toBe("asks");
    expect(bridge.gating(undefined)).toBe("asks");
  });

  it("passes model and effort only when they were asked for", () => {
    const opts: Record<string, unknown>[] = [];
    const bridge = codexBridge((o) => {
      opts.push({ ...o });
      return fakeSession();
    });
    bridge.create({ paneId: "ss-2", cwd: "/tmp" });
    bridge.create({ paneId: "ss-3", cwd: "/tmp", model: "gpt-5.6", effort: "high" });
    expect(opts[0]).not.toHaveProperty("model");
    expect(opts[0]).not.toHaveProperty("effort");
    expect(opts[1]).toMatchObject({ model: "gpt-5.6", effort: "high" });
  });
});

describe("codexOnPath", () => {
  it("is false with nothing on PATH", () => {
    expect(codexOnPath(emptyPath)).toBe(false);
    expect(codexOnPath({})).toBe(false);
  });
});

function fakeSession() {
  return {
    conversation: {
      onUpdate: () => {},
      page: () => {
        throw new Error("unused");
      },
      pendingPermission: () => undefined,
    },
    alive: true,
    thread: undefined,
    start: async () => {},
    prompt: async () => {},
    interrupt: async () => {},
    decide: () => false,
    close: () => {},
  };
}

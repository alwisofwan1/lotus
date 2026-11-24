import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { ApprovalHost, type ApprovalAnswer, type ApprovalRequest } from "../approval-host.js";
import { runApprovalServer } from "../approval-server.js";
import { APPROVAL_PROMPT_TOOL, APPROVAL_SERVER_FLAG, APPROVAL_SERVER_NAME } from "../approval-script.js";

/**
 * Drives the **generated** MCP server against a real socket, the way `claude` does.
 *
 * No CLI involved: the protocol the server speaks was captured from the real one on
 * 2026-09-07, so a test that speaks the same three methods proves the piece Lotus owns.
 * `tools/call` arrives as `{name, arguments: {tool_name, input, tool_use_id}}`, and the
 * answer is JSON **inside** a text content block.
 */
const hosts: ApprovalHost[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.close();
});

function host(onRequest: (r: ApprovalRequest) => Promise<ApprovalAnswer>): ApprovalHost {
  const h = new ApprovalHost({ paneId: "ss-test", onRequest });
  hosts.push(h);
  return h;
}

/**
 * The real approval server, driven over streams instead of over a spawned process.
 *
 * It used to be spawned from the `--mcp-config` this host emits, which read as the most
 * faithful test available — and it was, while that config named a runtime and a script. It
 * now names *this executable* plus `--approval-server` (issue 26), and under a test runner
 * that resolves to the runner itself. So the two halves are tested where each can be:
 * the **config** by `mcpConfig names a command that can run`, and the **protocol** here,
 * against `runApprovalServer` — the same code the flag reaches, with its streams injected.
 */
function server(h: ApprovalHost): {
  send: (msg: unknown) => void;
  next: (id: number, timeoutMs?: number) => Promise<Record<string, unknown>>;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  runApprovalServer({ input, output, socketPath: h.socketPath });

  const seen: Array<Record<string, unknown>> = [];
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line !== "") seen.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  return {
    send: (msg) => input.write(`${JSON.stringify(msg)}\n`),
    next: async (id, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = seen.find((m) => m["id"] === id);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`no reply for id ${id}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

function callBody(reply: Record<string, unknown>): Record<string, unknown> {
  const result = reply["result"] as { content?: Array<{ text?: string }> };
  return JSON.parse(result.content?.[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("the Claude approval channel", () => {
  it("names its tool the way --permission-prompt-tool expects", () => {
    expect(APPROVAL_PROMPT_TOOL).toBe(`mcp__${APPROVAL_SERVER_NAME}__approve`);
  });

  it("puts its socket in a directory of its own, and cleans up", () => {
    // Used to assert the generated `approve.mjs` here too. No script is written any more —
    // the server is this executable re-invoked (issue 26) — so the socket is the whole of
    // what the directory is for, and cleanup is still the claim worth pinning.
    const h = host(async () => ({ behavior: "allow" }));
    expect(existsSync(h.socketPath)).toBe(true);
    h.close();
    expect(existsSync(h.socketPath)).toBe(false);
  });

  it("hands the runner's question to the host, and the host's answer back", async () => {
    const asked: ApprovalRequest[] = [];
    const h = host(async (r) => {
      asked.push(r);
      return { behavior: "allow" };
    });
    const mcp = server(h);
    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await mcp.next(1);
    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = (await mcp.next(2))["result"] as { tools: Array<{ name: string }> };
    expect(listed.tools.map((t) => t.name)).toEqual(["approve"]);

    mcp.send({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: {
        name: "approve",
        arguments: { tool_name: "Bash", input: { command: "rm -rf build" }, tool_use_id: "toolu_7" },
      },
    });
    const body = callBody(await mcp.next(3));

    expect(asked).toEqual([
      { toolName: "Bash", toolUseId: "toolu_7", input: { command: "rm -rf build" } },
    ]);
    // `allow` must echo the input back: the runner runs what the answer returns.
    expect(body).toEqual({ behavior: "allow", updatedInput: { command: "rm -rf build" } });
  });

  /**
   * A standing grant is the host's to decide and the runner's to enforce — this channel only
   * has to carry it intact. Probed 2026-09-08: with the rule below, two Bash calls were asked
   * about once; without it, twice.
   */
  it("carries a standing grant through to the runner", async () => {
    const rule = {
      type: "addRules" as const,
      rules: [{ toolName: "Bash" }],
      behavior: "allow" as const,
      destination: "session" as const,
    };
    const h = host(async () => ({ behavior: "allow", updatedPermissions: [rule] }));
    const mcp = server(h);
    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    await mcp.next(1);

    mcp.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "Bash", input: { command: "ls" } } },
    });
    const body = callBody(await mcp.next(2));

    expect(body).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls" },
      updatedPermissions: [rule],
    });
  });

  it("carries a refusal, with the reason the operator gave", async () => {
    const h = host(async () => ({ behavior: "deny", message: "not on prod" }));
    const mcp = server(h);
    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await mcp.next(1);
    mcp.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "Write", input: { file_path: "/etc/hosts" } } },
    });
    expect(callBody(await mcp.next(2))).toEqual({ behavior: "deny", message: "not on prod" });
  });

  it("waits as long as the operator does", async () => {
    // The property the whole feature rests on. Probed against the real CLI: a server that
    // never answers keeps the turn open indefinitely — so the host may take its time.
    let release: ((a: ApprovalAnswer) => void) | undefined;
    const h = host(() => new Promise<ApprovalAnswer>((resolve) => { release = resolve; }));
    const mcp = server(h);
    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await mcp.next(1);
    mcp.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "Bash", input: {} } },
    });
    await expect(mcp.next(2, 300)).rejects.toThrow(/no reply/);
    expect(release).toBeDefined();

    release?.({ behavior: "allow" });
    expect(callBody(await mcp.next(2))).toMatchObject({ behavior: "allow" });
  });

  it("denies rather than hangs when the host is gone", async () => {
    // A frozen turn is worse than a refusal the operator can see and retry.
    const h = host(async () => ({ behavior: "allow" }));
    const mcp = server(h);
    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await mcp.next(1);
    h.close();
    mcp.send({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "approve", arguments: { tool_name: "Bash", input: {} } },
    });
    expect(callBody(await mcp.next(2))).toMatchObject({ behavior: "deny" });
  });

  it("denies a request it cannot read rather than dropping it", async () => {
    const h = host(async () => ({ behavior: "allow" }));
    const mcp = server(h);
    mcp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await mcp.next(1);
    // No `tool_name` at all: the server still asks, and the host still answers.
    mcp.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "approve", arguments: {} } });
    expect(callBody(await mcp.next(2))).toMatchObject({ behavior: "deny" });
  });
});

/// What `claude` is actually handed to start the approval server.
///
/// It used to be a `.mjs` path plus `process.execPath`. On a compiled binary that command
/// ignores its argument and starts a second Lotus host, so the tool never registered and
/// every approval was refused rather than asked (issue 26).
describe("mcpConfig names a command that can run", () => {
  it("re-invokes this host with the approval flag, not a script for it to interpret", () => {
    const h = host(async () => ({ behavior: "allow" }));
    const cfg = JSON.parse(h.mcpConfig()) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const spec = cfg.mcpServers["lotus"]!;

    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toContain(APPROVAL_SERVER_FLAG);
    // The socket still travels by env — nothing to leak, and it is what the child dials back.
    expect(spec.env["LOTUS_APPROVAL_SOCKET"]).toBeTruthy();
  });
});

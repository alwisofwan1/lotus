import { connect } from "node:net";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { APPROVAL_SERVER_NAME, APPROVAL_TOOL_NAME } from "./approval-script.js";

/**
 * The MCP server `claude` calls to ask whether a tool may run.
 *
 * **A separate process, but not separate code.** `claude` spawns this itself from
 * `--mcp-config`, so it has to be a real process; it reaches back into the session that
 * started the cell over a unix socket the host owns (`LOTUS_APPROVAL_SOCKET`). A socket
 * rather than a port and a token: nothing to leak, no listener reachable from another
 * machine, and it behaves the same on a VPS.
 *
 * It used to live here as a **string** written to a temp file, run by `process.execPath`.
 * That command is wrong on the artefact this project actually ships: a compiled binary
 * ignores a script argument and starts a second Lotus host, so `mcp__lotus__approve` never
 * registered and every approval was refused instead of asked (issue 26). The process is now
 * this same host re-invoked with `--approval-server`, which makes `process.execPath` correct
 * by construction — and lets the protocol be ordinary typed code with ordinary tests.
 *
 * Protocol captured from the real CLI on 2026-09-07 and unchanged here:
 * - `tools/call` arrives as `{name, arguments: {tool_name, input, tool_use_id}}`.
 * - The answer is JSON **inside** a text content block.
 * - The CLI waits indefinitely, which is what lets a phone answer at its own pace.
 */
export interface ApprovalServerIo {
  input: Readable;
  output: Writable;
  /** Where the host is listening. Absent means deny: there is nobody to ask. */
  socketPath?: string | undefined;
}

interface SocketAnswer {
  behavior?: string;
  message?: string;
  updatedInput?: unknown;
  updatedPermissions?: unknown;
}

const TOOL = {
  name: APPROVAL_TOOL_NAME,
  description: "Ask the operator whether this tool may run. Blocks until they answer.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
};

/** One request, one reply, one connection — nothing is kept open between asks. */
function ask(socketPath: string | undefined, payload: unknown): Promise<SocketAnswer> {
  return new Promise((resolve) => {
    if (socketPath === undefined || socketPath === "") {
      return resolve({ behavior: "deny", message: "Lotus is not listening." });
    }
    let answered = false;
    const done = (v: SocketAnswer): void => { if (!answered) { answered = true; resolve(v); } };
    const socket = connect(socketPath, () => socket.write(`${JSON.stringify(payload)}\n`));
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      try { done(JSON.parse(buffer.slice(0, nl)) as SocketAnswer); }
      catch { done({ behavior: "deny", message: "Lotus sent an answer this build cannot read." }); }
      socket.end();
    });
    // A host that went away must deny rather than hang: the operator can no longer be asked,
    // and a turn frozen forever is worse than a refusal they can see and retry.
    socket.on("error", () => done({ behavior: "deny", message: "Lotus is no longer reachable." }));
    socket.on("close", () => done({ behavior: "deny", message: "Lotus closed the connection." }));
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Serves the three methods the CLI uses, until stdin closes. */
export function runApprovalServer(io: ApprovalServerIo): void {
  const send = (m: unknown): void => { io.output.write(`${JSON.stringify(m)}\n`); };

  createInterface({ input: io.input }).on("line", (line: string) => {
    void (async (): Promise<void> => {
      if (line.trim() === "") return;
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { return; }
      if (!isRecord(msg)) return;
      const id = msg["id"];
      const params = isRecord(msg["params"]) ? msg["params"] : {};

      if (msg["method"] === "initialize") {
        const asked = params["protocolVersion"];
        return send({ jsonrpc: "2.0", id, result: {
          protocolVersion: typeof asked === "string" ? asked : "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: APPROVAL_SERVER_NAME, version: "1.0.0" },
        }});
      }
      if (msg["method"] === "tools/list") {
        return send({ jsonrpc: "2.0", id, result: { tools: [TOOL] } });
      }
      if (msg["method"] === "tools/call") {
        const args = isRecord(params["arguments"]) ? params["arguments"] : {};
        const meta = isRecord(params["_meta"]) ? params["_meta"] : {};
        const input = isRecord(args["input"]) ? args["input"] : {};
        const answer = await ask(io.socketPath, {
          toolName: typeof args["tool_name"] === "string" ? args["tool_name"] : "",
          toolUseId: args["tool_use_id"] ?? meta["claudecode/toolUseId"] ?? "",
          input,
        });
        return send({ jsonrpc: "2.0", id, result: {
          content: [{ type: "text", text: JSON.stringify(
            answer.behavior === "allow"
              // The host may rewrite what the tool runs with, and for `AskUserQuestion` that
              // is the only way the operator's choice reaches the tool at all. Absent means
              // "as it asked", which is every ordinary grant.
              ? {
                  behavior: "allow",
                  updatedInput: answer.updatedInput ?? input,
                  // A standing grant, when the operator gave one. Absent means this call
                  // only, which is every ordinary allow.
                  ...(answer.updatedPermissions ? { updatedPermissions: answer.updatedPermissions } : {}),
                }
              : { behavior: "deny", message: answer.message ?? "The operator declined." },
          ) }],
        }});
      }
      if (id !== undefined) send({ jsonrpc: "2.0", id, result: {} });
    })();
  });
}

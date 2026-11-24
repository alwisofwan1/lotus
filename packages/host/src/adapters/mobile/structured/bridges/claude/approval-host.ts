import { createServer, type Server, type Socket } from "node:net";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { approvalMcpConfig } from "./approval-script.js";

/**
 * The host end of the approval channel: a unix socket the generated MCP server connects to,
 * one request per connection.
 *
 * Answering is **not** this class's business — it hands the request to [`onRequest`] and
 * waits for whatever that resolves to. The session above it is what knows there is a phone,
 * and the conversation is what knows how to describe the question.
 *
 * The socket and the script live in a directory created per session with `0700`, removed on
 * [`close`]. A socket rather than a localhost port: nothing to leak, nothing another machine
 * can reach, and the same behaviour on a VPS.
 */
export interface ApprovalRequest {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
}

/**
 * A rule the runner should hold for the rest of this session.
 *
 * The shape `--permission-prompt-tool` was proved to honour on 2026-09-08: two Bash calls behind
 * one of these were asked about once, against twice in the control. `destination` is `session`
 * and only ever `session` — a rule written to the operator's settings would outlive the cell
 * that asked for it, and a permission granted once from a phone must not become one the machine
 * holds forever.
 */
export interface SessionPermissionRule {
  type: "addRules";
  rules: Array<{ toolName: string }>;
  behavior: "allow";
  destination: "session";
}

/**
 * `updatedInput` rewrites the arguments the tool will run with. Absent means "as it asked",
 * which is every ordinary grant; present is how a question's answer reaches the tool that
 * asked it (`questions.ts`).
 *
 * `updatedPermissions` is the standing grant, and absent means this call only.
 */
export type ApprovalAnswer =
  | {
      behavior: "allow";
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: SessionPermissionRule[];
    }
  | { behavior: "deny"; message: string };

export interface ApprovalHostOptions {
  paneId: string;
  onRequest: (request: ApprovalRequest) => Promise<ApprovalAnswer>;
}

export class ApprovalHost {
  readonly socketPath: string;
  private readonly dir: string;
  private readonly server: Server;
  private readonly open = new Set<Socket>();
  /**
   * Why the socket could not be opened, when it could not.
   *
   * `listen` on a unix socket fails as an **asynchronous** `error` event, so without a
   * handler it is an uncaught exception that takes the whole host down — a cell refusing to
   * approve is a bad afternoon, a host that exits is every cell at once. A sandbox or a
   * read-only temp dir answers `EPERM` here, and the generated MCP server then cannot
   * connect and denies on its own, which is the fallback this whole channel was designed
   * around.
   */
  listenError: Error | undefined;

  constructor(private readonly opts: ApprovalHostOptions) {
    this.dir = mkdtempSync(join(tmpdir(), `lotus-approve-${opts.paneId}-`));
    chmodSync(this.dir, 0o700);
    // No script is written any more: the server is this executable re-invoked with
    // `--approval-server` (issue 26). The temp dir survives for the socket alone.
    this.socketPath = join(this.dir, "approve.sock");
    this.server = createServer((socket) => this.serve(socket));
    this.server.on("error", (err) => {
      this.listenError = err;
    });
    this.server.listen(this.socketPath);
  }

  /** What `claude` needs on its command line to route prompts here. */
  mcpConfig(): string {
    // Re-invokes this host with `--approval-server` rather than handing over a script for
    // some other runtime to interpret. `nodePath` used to be the escape hatch for a host
    // that is a compiled binary — it was declared and never once set, so every such host
    // silently lost all approvals (issue 26).
    return approvalMcpConfig(this.socketPath, process.execPath, process.argv);
  }

  close(): void {
    for (const socket of this.open) socket.destroy();
    this.open.clear();
    this.server.close();
    rmSync(this.dir, { recursive: true, force: true });
  }

  private serve(socket: Socket): void {
    this.open.add(socket);
    socket.on("close", () => this.open.delete(socket));
    socket.on("error", () => this.open.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      void this.answer(socket, line);
    });
  }

  private async answer(socket: Socket, line: string): Promise<void> {
    const request = readRequest(line);
    // A request this host cannot read is denied rather than dropped: dropping it would leave
    // the runner waiting forever, which is the one outcome worse than a refusal.
    const answer: ApprovalAnswer =
      request === undefined
        ? { behavior: "deny", message: "Lotus could not read the request." }
        : await this.opts.onRequest(request).catch(() => ({
            behavior: "deny" as const,
            message: "Lotus failed to ask.",
          }));
    if (!socket.destroyed) socket.write(`${JSON.stringify(answer)}\n`);
  }
}

function readRequest(line: string): ApprovalRequest | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const raw = parsed as Record<string, unknown>;
    // An empty name is not a readable request: the operator would be shown a card that
    // names no tool, which is worse than the refusal they can see and retry.
    if (typeof raw["toolName"] !== "string" || raw["toolName"] === "") return undefined;
    return {
      toolName: raw["toolName"],
      toolUseId: typeof raw["toolUseId"] === "string" ? raw["toolUseId"] : "",
      input:
        typeof raw["input"] === "object" && raw["input"] !== null && !Array.isArray(raw["input"])
          ? (raw["input"] as Record<string, unknown>)
          : {},
    };
  } catch {
    return undefined;
  }
}

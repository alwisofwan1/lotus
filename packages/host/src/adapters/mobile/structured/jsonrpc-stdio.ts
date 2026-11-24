import type { Readable, Writable } from "node:stream";

/**
 * JSON-RPC 2.0 over newline-delimited stdio — the transport every provider bridge here
 * shares, since `codex app-server` and ACP agents speak the same framing.
 *
 * Verified against both real binaries (codex 0.150.1 on 2026-08-27, `cursor-agent acp` on
 * 2026-09-06): one JSON object per line, the
 * `"jsonrpc"` header omitted on the wire, and **the server also sends requests** — an
 * approval is `{id, method: "item/commandExecution/requestApproval", params}` and expects
 * `{id, result: {decision}}` back on the same id space. So a line with both `id` and
 * `method` is a request *to* us; with `id` and no `method` it is a response; with `method`
 * and no `id` it is a notification.
 *
 * Nothing here knows any provider's vocabulary. It is the transport, tested with two
 * `PassThrough` streams; the session on top decides what to say.
 */
export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcServerRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

export type ServerRequestHandler = (req: JsonRpcServerRequest) => Promise<unknown>;

export class JsonRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class JsonRpcStdio {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers: Array<(n: JsonRpcNotification) => void> = [];
  private serverRequestHandler: ServerRequestHandler = async (req) => {
    throw new JsonRpcError(-32601, `unsupported server request ${req.method}`);
  };
  private buffer = "";
  private closed = false;

  constructor(private readonly input: Readable, private readonly output: Writable, private readonly label = "the agent") {
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.onData(chunk));
    input.on("end", () => this.onClose(new Error(`${this.label} closed its output`)));
    input.on("error", (err) => this.onClose(err));
  }

  onNotification(handler: (n: JsonRpcNotification) => void): void {
    this.notificationHandlers.push(handler);
  }

  /** One handler: whatever it returns is the `result`; whatever it throws becomes the `error`. */
  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("app-server connection is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  private write(message: object): void {
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl = this.buffer.indexOf("\n");
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line !== "") this.onLine(line);
      nl = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A stray non-JSON line is noise, not a protocol failure — the Codex TUI prints
      // warnings on the same channel in some builds. Ignored, like `codex-stream.ts` does.
      return;
    }
    const hasId = typeof msg["id"] === "number" || typeof msg["id"] === "string";
    const method = typeof msg["method"] === "string" ? (msg["method"] as string) : undefined;
    if (hasId && method !== undefined) {
      void this.answer({ id: msg["id"] as number | string, method, params: msg["params"] });
      return;
    }
    if (hasId) {
      const pending = this.pending.get(msg["id"] as number);
      if (pending === undefined) return;
      this.pending.delete(msg["id"] as number);
      const error = msg["error"] as { code?: number; message?: string; data?: unknown } | undefined;
      if (error !== undefined) {
        pending.reject(new JsonRpcError(error.code ?? -32000, error.message ?? "app-server error", error.data));
      } else {
        pending.resolve(msg["result"]);
      }
      return;
    }
    if (method !== undefined) {
      for (const h of this.notificationHandlers) h({ method, params: msg["params"] });
    }
  }

  private async answer(req: JsonRpcServerRequest): Promise<void> {
    try {
      const result = await this.serverRequestHandler(req);
      this.write({ id: req.id, result: result ?? {} });
    } catch (err) {
      const code = err instanceof JsonRpcError ? err.code : -32000;
      const message = err instanceof Error ? err.message : String(err);
      this.write({ id: req.id, error: { code, message } });
    }
  }

  private onClose(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

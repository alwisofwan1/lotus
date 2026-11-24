/*
 * JSON-RPC 2.0 over one language server session: requests with ids and answers, notifications,
 * and the requests a server sends back. Framing is Rust's (`editor_lsp.rs`); this sees whole
 * messages as text.
 */

export type JsonRpcId = number | string;

type Message = {
  jsonrpc?: "2.0";
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class LspRequestError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "LspRequestError";
  }
}

/** The server did not answer, or went away, before the answer came. */
export class LspConnectionClosedError extends Error {
  constructor() {
    super("Language server stopped");
    this.name = "LspConnectionClosedError";
  }
}

export const LSP_ERRORS = {
  methodNotFound: -32601,
  requestCancelled: -32800,
  contentModified: -32801,
} as const;

type RequestHandler = (params: unknown) => unknown;
type NotificationHandler = (params: unknown) => void;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

export type LspConnectionOptions = {
  /** Writes one message to the server. */
  send: (message: string) => Promise<void>;
  /** A request still unanswered after this is given up (default: never). */
  timeoutMs?: number;
};

export class LspConnection {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private closed = false;

  constructor(private readonly options: LspConnectionOptions) {}

  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /**
   * Sends a request. `signal` cancels it: the promise rejects at once and the server is told
   * (`$/cancelRequest`), so a hover the mouse left stops costing the server work.
   */
  request<T>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new LspConnectionClosedError());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = this.options.timeoutMs;
      const pending: Pending = {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer: timeout
          ? setTimeout(() => {
            this.pending.delete(id);
            reject(new LspRequestError(LSP_ERRORS.requestCancelled, `${method} timed out`));
          }, timeout)
          : null,
      };
      this.pending.set(id, pending);
      if (signal) {
        if (signal.aborted) {
          this.cancel(id);
          return;
        }
        signal.addEventListener("abort", () => this.cancel(id), { once: true });
      }
      this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }).catch((error) => {
        this.settle(id)?.reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    void this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }).catch(() => {});
  }

  /** One message from the server. */
  receive(text: string): void {
    let message: Message;
    try {
      message = JSON.parse(text) as Message;
    } catch {
      return;
    }
    if (message.method !== undefined && message.id !== undefined && message.id !== null) {
      void this.answer(message.id, message.method, message.params);
      return;
    }
    if (message.method !== undefined) {
      this.notificationHandlers.get(message.method)?.(message.params);
      return;
    }
    if (message.id === undefined || message.id === null) return;
    const pending = this.settle(message.id);
    if (!pending) return;
    if (message.error) pending.reject(new LspRequestError(message.error.code, message.error.message));
    else pending.resolve(message.result ?? null);
  }

  /** The session ended: every open request fails, and nothing more is sent. */
  close(): void {
    this.closed = true;
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(new LspConnectionClosedError());
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private cancel(id: JsonRpcId): void {
    const pending = this.settle(id);
    if (!pending) return;
    pending.reject(new LspRequestError(LSP_ERRORS.requestCancelled, "cancelled"));
    this.notify("$/cancelRequest", { id });
  }

  private settle(id: JsonRpcId): Pending | null {
    const pending = this.pending.get(id);
    if (!pending) return null;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    return pending;
  }

  private async answer(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      await this.write({ jsonrpc: "2.0", id, error: { code: LSP_ERRORS.methodNotFound, message: `Unhandled method ${method}` } }).catch(() => {});
      return;
    }
    try {
      const result = await handler(params);
      await this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.write({ jsonrpc: "2.0", id, error: { code: -32603, message } }).catch(() => {});
    }
  }

  private write(message: Message): Promise<void> {
    return this.options.send(JSON.stringify(message));
  }
}

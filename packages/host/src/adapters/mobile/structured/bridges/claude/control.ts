import type { ClaudeMessage } from "./messages.js";

/**
 * Asks `claude` to change itself over a pipe shared with the conversation
 * (`control_request` in, `control_response` out). A response that fell through to the timeline
 * would draw as an `unknown` step, so [`settle`] answers *"was this mine?"*.
 */
export class ControlChannel {
  private readonly pending = new Map<
    string,
    { settle: (body: Record<string, unknown>) => void; fail: (error: Error) => void }
  >();
  private next = 0;

  constructor(private readonly write: (line: string) => void) {}

  /**
   * Sends one request and resolves with the runner's own answer.
   *
   * Bounded: a runner too old to know a control answers **nothing at all**.
   */
  async request(
    request: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const requestId = `ctl-${this.next++}`;
    const answered = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(requestId, { settle: resolve, fail: reject });
    });
    this.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request })}\n`);

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        answered,
        new Promise<Record<string, unknown>>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`the runner did not answer in ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      this.pending.delete(requestId);
    }
  }

  /** Whether this line was control traffic — and therefore never the conversation's. */
  settle(message: ClaudeMessage): boolean {
    if (message.type !== "control_response") return message.type === "control_request";
    const body = asRecord(message["response"]);
    const requestId = typeof body["request_id"] === "string" ? body["request_id"] : "";
    const held = this.pending.get(requestId);
    if (held === undefined) return true;
    this.pending.delete(requestId);
    if (body["subtype"] === "success") {
      held.settle(asRecord(body["response"]));
    } else {
      const error = body["error"];
      held.fail(new Error(typeof error === "string" ? error : "the runner refused the change"));
    }
    return true;
  }

  /** Fails everything still waiting. A dead process answers nothing, ever. */
  abandon(reason: string): void {
    for (const [, held] of this.pending) held.fail(new Error(reason));
    this.pending.clear();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

import type { ClaudeMessage } from "./messages.js";

/**
 * The runner's control channel: asking `claude` to change something about **itself**, and
 * waiting for it to say it did.
 *
 * Split out of `session.ts` when that file crossed the 300-line rule, and the seam is a real
 * one: everything here is request/response correlation over a channel that happens to share a
 * pipe with the conversation, where what stays behind is the conversation itself — prompts,
 * turns, approvals.
 *
 * **It shares one stdout with the transcript, and that is the hazard it exists to contain.**
 * A `control_response` left to fall through to the timeline draws as an `unknown` part —
 * protocol chatter rendered to the operator as a step the agent took. So [`settle`] answers
 * *"was this mine?"* and the caller stops there when it was.
 *
 * Probed against the real CLI on 2026-09-09: `{type:"control_request", request_id, request:{…}}`
 * on the same stdin is answered with
 * `{type:"control_response", response:{subtype:"success", request_id, response:{…}}}`, and the
 * effect is real — a cell spawned `manual` stopped gating `rm -f` once a `set_permission_mode`
 * landed.
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
   * Bounded, because a runner too old to know a control answers **nothing at all** — and a cell
   * frozen on a settings tap is worse than one that says it could not change.
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

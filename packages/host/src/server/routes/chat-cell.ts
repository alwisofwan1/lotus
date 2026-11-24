import type { ChatActionResult } from "../../types/conversation.js";
import type { RouteHandler } from "../router.js";
import type { StructuredFleetRef } from "../structured-fleet-ref.js";
import { readJson } from "./utils.js";

interface RecentOptions {
  ttlMs?: number;
  max?: number;
  now?: () => number;
}

/** Answers by `requestId`, so a retried spawn or send runs once (in-memory: a host restart forgets them). */
export class RecentAnswers {
  readonly #held = new Map<string, { at: number; answer: Promise<ChatActionResult> }>();
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;

  constructor(opts: RecentOptions = {}) {
    this.#ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.#max = opts.max ?? 1000;
    this.#now = opts.now ?? Date.now;
  }

  get(id: string): Promise<ChatActionResult> | undefined {
    const hit = this.#held.get(id);
    if (hit === undefined) return undefined;
    if (this.#now() - hit.at > this.#ttlMs) {
      this.#held.delete(id);
      return undefined;
    }
    return hit.answer;
  }

  forget(id: string): void {
    this.#held.delete(id);
  }

  remember(id: string, answer: Promise<ChatActionResult>): void {
    this.#held.set(id, { at: this.#now(), answer });
    // A Map iterates in insertion order, so the first key is the oldest.
    while (this.#held.size > this.#max) this.#held.delete(this.#held.keys().next().value as string);
  }
}

/**
 * `POST /v1/chat-cell/:action` — spawn, send, answer, stop, posture, close, permission on a headless cell.
 *
 * The desktop Chat's counterpart of the phone's `/m/cells` routes; the adapter decides every answer.
 */
export function chatCellHandler(structured: StructuredFleetRef | undefined, recent = new RecentAnswers()): RouteHandler {
  return async (req, res, params) => {
    const reply = ({ status, body }: ChatActionResult): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const parsed: unknown = await readJson<unknown>(req).catch(() => undefined);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return reply({ status: 400, body: { ok: false, error: "body must be a JSON object" } });
    }
    const body = parsed as Record<string, unknown>;
    const action = params["action"] ?? "";
    const run = (): Promise<ChatActionResult> =>
      structured?.act(action, body) ?? Promise.resolve({ status: 503, body: { ok: false, error: "this host runs no headless cells" } });

    const requestId = typeof body["requestId"] === "string" ? body["requestId"].trim() : "";
    if (requestId === "") return reply(await run());
    const key = `${action}:${requestId}`;
    const earlier = recent.get(key);
    if (earlier !== undefined) return reply(await earlier);
    const answer = run();
    recent.remember(key, answer);
    // A call that threw did nothing the caller can rely on, so its retry runs again.
    answer.catch(() => recent.forget(key));
    reply(await answer);
  };
}

import type { ServerResponse } from "node:http";
import type { RouteHandler } from "../router.js";
import type { DirectorSupervisor } from "../director/supervisor.js";
import { readJson } from "./utils.js";

/**
 * `/api/director/goal` — submits a goal to the Headless Director. A Director
 * turn can run for minutes, so this accepts the goal and returns **202
 * immediately** (fire-and-forget); the Director's reply is delivered
 * asynchronously via the notification stream, which the remote adapter relays
 * to the chat. Blocking here would trip HTTP/undici header timeouts (ADR-0019).
 */
interface GoalBody { text?: string }

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function submitGoalHandler(director: DirectorSupervisor | undefined): RouteHandler {
  return async (req, res) => {
    if (!director) {
      send(res, 503, { error: "Headless Director is not enabled on this host" });
      return;
    }
    const body = await readJson<GoalBody>(req).catch(() => null);
    if (!body) return send(res, 400, { error: "Invalid JSON body" });
    if (!body.text || !body.text.trim()) return send(res, 400, { error: "text is required" });

    // Do NOT await — the supervisor surfaces the reply (and any error) through
    // its onReply sink → notification stream. It never rejects, so this catch
    // is only a backstop against an unexpected synchronous throw.
    void director.submitGoal(body.text).catch(() => undefined);
    send(res, 202, { ok: true, accepted: true });
  };
}

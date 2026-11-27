import type { ServerResponse } from "node:http";
import type { RouteHandler } from "../router.js";
import type { DirectorSupervisor } from "../director/supervisor.js";
import { readJson } from "./utils.js";

/** Return 202 before the Director turn finishes so long turns cannot hit HTTP timeouts (ADR-0019). */
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

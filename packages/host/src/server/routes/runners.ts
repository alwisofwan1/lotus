import type { ServerResponse } from "node:http";

import { onPath } from "../../core/on-path.js";
import type { ListRunnersResponse, RunnerSummary } from "../../types/runners.js";
import type { AgentRunnerRegistry } from "../agent/registry.js";
import type { RouteHandler } from "../router.js";

/** Advertise only installed runners because every entry is a launch choice. */
export function listRunnersHandler(
  registry: AgentRunnerRegistry,
  installed: (command: string) => boolean = (command) => onPath(command),
): RouteHandler {
  return (_req, res): void => {
    const items = registry
      .list()
      .map((id) => summarise(id))
      .filter((runner) => installed(binaryFor(runner.id)));
    sendJson(res, 200, { items } satisfies ListRunnersResponse);
  };
}

/** Check the underlying Claude executable for CCS profiles because profile IDs are not binary names. */
function binaryFor(id: string): string {
  return id.startsWith("ccs:") ? "claude" : id;
}

/** What the operator reads. Native ids only; anything else keeps its id as its name. */
const NAMES: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor Agent",
};

/** Match desktop semantics by using claudeFamily only for custom commands. */
function summarise(id: string): RunnerSummary {
  const account = id.startsWith("ccs:") ? id.slice("ccs:".length) : undefined;
  return {
    id,
    name: account ?? NAMES[id] ?? id,
    claudeFamily: account !== undefined,
    custom: account !== undefined,
    pinsTuning: false,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

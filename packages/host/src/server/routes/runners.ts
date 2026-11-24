import type { ServerResponse } from "node:http";

import { onPath } from "../../core/on-path.js";
import type { ListRunnersResponse, RunnerSummary } from "../../types/runners.js";
import type { AgentRunnerRegistry } from "../agent/registry.js";
import type { RouteHandler } from "../router.js";

/**
 * What this machine can launch — the answer a Standalone Host had no way to give.
 *
 * The mobile façade builds `bootstrap.runners[]` from this route, and a host without it
 * answered 404, which `orNotSupported` turns into an empty list. Empty and absent are the
 * same thing to that helper, which is why the gap was invisible: every per-runner field the
 * phone reads — `headless`, `profiles`, `models` — silently never reached a VPS, the one
 * deployment those fields exist for. Found by running it (2026-09-07), not by a test.
 *
 * **Only runners whose binary is here.** {@link RunnerSummary} has no `installed` flag —
 * unlike the desktop's own registry, which reports uninstalled CLIs so Settings can draw
 * them greyed out. A phone gets a list to start things from, so a row it cannot start is
 * worse than a row that is missing.
 */
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

/**
 * The binary a runner needs, which is not always its id.
 *
 * `ccs:<account>` runs the `claude` binary under another config dir, so it is startable
 * exactly when `claude` is. Probing for a `ccs:initech` executable would hide every
 * second-account runner on a machine that has them.
 */
function binaryFor(id: string): string {
  return id.startsWith("ccs:") ? "claude" : id;
}

/** What the operator reads. Native ids only; anything else keeps its id as its name. */
const NAMES: Readonly<Record<string, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor Agent",
};

/**
 * One runner as the façade's contract describes it, matching the desktop's own answers.
 *
 * `claudeFamily` is **false for a native runner even for `claude` itself** — that is the
 * desktop's semantic, not an oversight: the flag says "this is a custom command that runs
 * the claude binary", so hooks fire and it can be gated, and it is only meaningful for
 * custom runners (`runners.rs`: *"the flag is only meaningful for custom runners"*).
 * Answering differently here would make one host disagree with the other about the same
 * runner, which is the class of bug `runnerLabel` was added to end.
 *
 * `pinsTuning: false` because these commands are built by this host, not typed by the
 * operator: nothing in them fixes a model or an effort, so the phone's knobs are honoured.
 */
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

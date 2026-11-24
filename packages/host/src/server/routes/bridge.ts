import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentRunnerRegistry } from "../agent/registry.js";
import type { RouteHandler } from "../router.js";
import type { BridgeChatRequest, BridgeChatResponse, HostedProject } from "../../types/index.js";
import type { AgentProviderId } from "../agent/types.js";
import { ProviderUnavailableError } from "../agent/errors.js";
import type { ProjectRegistry } from "../projects/registry.js";
import { readJson } from "./utils.js";
import { streamJsonReply } from "./stream-reply.js";

/** Tunables for the streamed bridge reply (heartbeat cadence + turn timeout). */
export interface BridgeChatStreamOptions {
  heartbeatMs?: number;
  timeoutMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60_000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function findHostedProject(cwd: string, projectRegistry: ProjectRegistry): HostedProject | null {
  const projects = projectRegistry.list();
  if (projects.length === 0) return null;
  const target = resolve(cwd);
  return projects.find((project) => {
    const root = resolve(project.path);
    const rel = relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }) ?? null;
}

function isPolicyAllowed(project: HostedProject | null, body: BridgeChatRequest): boolean {
  if (!project || body.intent !== "write") return true;
  const policy = project.policy ?? "approval-required";
  if (policy === "trusted-yolo") return true;
  if (policy === "read-only") return false;
  return body.approved === true;
}

export function bridgeChatHandler(
  agentRunners: AgentRunnerRegistry,
  projectRegistry: ProjectRegistry,
  opts: BridgeChatStreamOptions = {},
): RouteHandler {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let body: BridgeChatRequest;
    try {
      body = await readJson<BridgeChatRequest>(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    if (!body.text) {
      sendJson(res, 400, { error: "text is required" });
      return;
    }
    const cwd = body.cwd ?? process.env["PROJECTS_ROOT"] ?? process.cwd();
    const projectsConfigured = projectRegistry.list().length > 0;
    const project = findHostedProject(cwd, projectRegistry);
    if (projectsConfigured && !project) {
      sendJson(res, 403, { error: "cwd must be inside a configured Hosted Project" });
      return;
    }
    if (!isPolicyAllowed(project, body)) {
      sendJson(res, 403, { error: "project policy rejected this Bridge request" });
      return;
    }

    const providerStr = body.provider ?? "claude";
    const provider = providerStr as AgentProviderId;
    const runner = agentRunners.get(provider);
    if (!runner) {
      sendJson(res, 400, { error: `Unknown provider: ${providerStr}` });
      return;
    }

    // Stream the reply: a bridge turn can run for minutes (agentic tool use),
    // which would otherwise trip the client's 5-minute header timeout and
    // surface as "fetch failed". Headers go out immediately; whitespace
    // heartbeats keep the body timeout from firing; the final JSON value is the
    // BridgeChatResponse (or an error frame the client maps to an ApiError).
    await streamJsonReply(
      req,
      res,
      async (signal): Promise<BridgeChatResponse> => {
        const result = await runner.chat({
          prompt: body.text,
          sessionId: body.sessionId ?? null,
          cwd,
          provider,
          remoteScoped: body.remoteScoped ?? false,
          ...(body.model ? { model: body.model } : {}),
          signal,
        });
        return {
          sessionId: result.sessionId,
          text: result.text,
          isError: result.isError,
          provider: providerStr,
        };
      },
      (err) => {
        if (err instanceof ProviderUnavailableError) return { error: err.message, errorStatus: 503 };
        // Surface the cause (e.g. a turn-timeout / abort message) — the bridge
        // already relays agent errors to the user, so a generic mask would only
        // hide actionable info. Falls back to a generic string for non-Errors.
        return { error: err instanceof Error ? err.message : "Internal server error", errorStatus: 500 };
      },
      { heartbeatMs, timeoutMs },
    );
  };
}

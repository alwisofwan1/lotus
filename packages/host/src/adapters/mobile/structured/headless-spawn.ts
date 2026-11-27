import type { ServerResponse } from "node:http";

import type { ApiClient } from "../../../core/api-client.js";
import { send } from "../http-util.js";
import { normalizeProjects } from "../projects-normalize.js";
import { runnerFamily, runnerProfileId } from "../../../core/runner-family.js";
import { DEFAULT_ACCOUNT, hostDefaultAccount } from "../../../core/accounts/index.js";
import { claudeProfiles } from "./bridges/claude/index.js";
import type { StructuredSessions } from "./structured-sessions.js";

/**
 * `POST /m/cells {tui: false}` — an agent this host runs itself. Own file because the cell
 * routes are a thin desktop pass-through. Accepted runners come from the registry, the same
 * list `/m/bootstrap` advertises (`spawn-tuning.ts` → `headless`).
 */
export interface HeadlessSpawnRequest {
  provider: string;
  workspaceId: string | undefined;
  initialPrompt?: string;
  permissionMode?: string;
  model?: string;
  effort?: string;
  /** Which authenticated account to run as, from the list `bootstrap` advertised. */
  profileId?: string;
}

export interface HeadlessSpawnDeps {
  /** Absent on a host with no structured path at all — the first refusal below. */
  structured?: StructuredSessions;
  api: Pick<ApiClient, "listProjects">;
  onAsk?: (paneId: string) => void;
  /** The accounts this machine has. Injected so a test never scans a real home directory. */
  profiles?: () => readonly { id: string }[];
  /** The account this host's own spawns run as when the request names none; Claude family only. */
  hostDefault?: () => string | undefined;
}

/** Answers `res` in every case, and reports the pane so the caller can audit it. */
export async function spawnHeadlessCell(
  res: ServerResponse,
  req: HeadlessSpawnRequest,
  deps: HeadlessSpawnDeps,
): Promise<{ paneId: string } | undefined> {
  const { structured } = deps;
  if (structured === undefined) {
    send(res, 400, { error: "this host cannot run an agent without a terminal" });
    return undefined;
  }
  // A runner this host has no bridge *of its own* for may still be a member of a family it
  // does: `ccs initech` is the Claude bridge under that account's config dir. Resolving it
  // here is what lets a whole family of runners have a streaming Chat and a structured
  // permission instead of a terminal and a screen-scrape (`agent/runner-family.ts`).
  const family = structured.canRun(req.provider) ? undefined : runnerFamily(req.provider);
  const provider = family?.provider ?? req.provider;
  // `default` means no CLAUDE_CONFIG_DIR, which a bridge configDir cannot express, so it is left out.
  const chosen = provider === "claude" ? (deps.hostDefault ?? hostDefaultAccount)() : undefined;
  const profileId = req.profileId ?? runnerProfileId(req.provider) ?? (chosen === "default" ? undefined : chosen);
  if (!structured.canRun(provider)) {
    const available = structured.headlessRunners();
    send(res, 400, {
      error:
        available.length === 0
          ? "this host has no runner that can start without a terminal"
          : `tui: false is available for ${available.join(", ")} on this host`,
    });
    return undefined;
  }
  if (req.workspaceId === undefined) {
    send(res, 400, { error: "workspaceId is required for tui: false" });
    return undefined;
  }
  // Validated here so the bridge never has to refuse mid-spawn, and so a stale client is told
  // what this machine actually has. Getting this wrong is not an error the operator would see
  // as one — a cell on the wrong account works, as somebody else.
  if (profileId !== undefined) {
    const known = (deps.profiles ?? claudeProfiles)();
    if (!known.some((p) => p.id === profileId)) {
      send(res, 400, {
        error: known.length === 0
          ? "this host has no named accounts to run as"
          : `no account named "${profileId}" — this host has ${known.map((p) => p.id).join(", ")}`,
      });
      return undefined;
    }
  }
  const project = normalizeProjects(await deps.api.listProjects()).find(
    (p) => p.workspaceId === req.workspaceId,
  );
  if (project === undefined) {
    send(res, 404, { error: `no project for workspace ${req.workspaceId}` });
    return undefined;
  }
  const member = await structured.spawn({
    workspaceId: req.workspaceId,
    workspaceLabel: project.name,
    cwd: project.path,
    agentType: provider,
    ...(family?.runnerLabel === undefined ? {} : { runnerLabel: family.runnerLabel }),
    ...(req.initialPrompt === undefined ? {} : { initialPrompt: req.initialPrompt }),
    ...(req.permissionMode === undefined ? {} : { permissionMode: req.permissionMode }),
    ...(req.model === undefined ? {} : { model: req.model }),
    ...(req.effort === undefined ? {} : { effort: req.effort }),
    // `default` is the CLI's own dir with no CLAUDE_CONFIG_DIR; a bridge configDir would name it and change its keychain item.
    ...(profileId === undefined || profileId === DEFAULT_ACCOUNT ? {} : { profileId }),
  });
  if (req.initialPrompt !== undefined) deps.onAsk?.(member.paneId);
  send(res, 200, { paneId: member.paneId, sessionId: member.sessionId ?? "" });
  return { paneId: member.paneId };
}

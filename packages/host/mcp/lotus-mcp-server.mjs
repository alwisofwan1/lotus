#!/usr/bin/env bun
/**
 * VENDORED COPY of scripts/lotus-mcp-server.mjs (source commit e119e2c7).
 * Bundled with lotus-remote so the Standalone Orchestrator deploys on a bare VPS
 * (ADR-0019). Keep in sync with the root copy; re-vendor + bump the commit above.
 *
 * Lotus MCP Server — stdio transport for Claude CLI.
 *
 * Claude CLI spawns this process (per ~/.claude.json mcpServers.lotus config).
 * We expose a small tool surface that gives Claude the ability to observe and
 * coordinate other Terminal cells running inside Lotus. Every tool call is
 * forwarded to the running Lotus Tauri app via a localhost HTTP IPC server
 * (see src-tauri/src/mcp_ipc.rs) whose port + shared secret live in
 * the discovery file passed via --discovery (prod/dev use separate paths).
 *
 * Design notes:
 *  - We never cache IPC config between calls — re-read on each request so a
 *    Lotus restart (new port/secret) does not require killing this process.
 *  - If Lotus is not running (no ipc.json or ECONNREFUSED), we return a
 *    structured tool error, not a process crash. Claude CLI surfaces it.
 *  - Keep this file dependency-light: only @modelcontextprotocol/sdk + stdlib.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_IPC_CONFIG_PATH = join(homedir(), ".claude", "lotus-mcp-ipc.json");

function resolveDiscoveryPath(argv = process.argv) {
  const args = Array.isArray(argv) ? argv : [];
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--discovery") {
      const value = args[index + 1];
      if (typeof value === "string" && value.trim()) return value;
    }
    if (typeof arg === "string" && arg.startsWith("--discovery=")) {
      const value = arg.slice("--discovery=".length);
      if (value.trim()) return value;
    }
  }
  return DEFAULT_IPC_CONFIG_PATH;
}

const IPC_CONFIG_PATH = resolveDiscoveryPath();

/**
 * Per-route client-side abort timeout. A hardcoded global 5s cap used to
 * strangle `lotus_wait_cell_idle` whose semantic timeout can legitimately
 * reach 60s — the sidecar would disconnect the client at 5s even though
 * Rust was still waiting. Default 8s, wait-cell-idle gets 65s so it always
 * exceeds Rust's `timeout_ms` (capped at 60s server-side).
 */
const IPC_ROUTE_TIMEOUTS_MS = {
  "/v1/list-fleet": 5_000,
  "/v1/spawn-cell": 12_000, // Rust already waits up to 6s, add slack.
  "/v1/close-cell": 8_000,
  "/v1/dispatch-to-cell": 5_000,
  "/v1/read-cell-output": 5_000,
  "/v1/tasks/create": 5_000,
  "/v1/tasks/update": 5_000,
  "/v1/tasks/append-feedback-event": 5_000,
  "/v1/tasks/list": 5_000,
  "/v1/tasks/get": 5_000,
  "/v1/wait-cell-idle": 65_000,
  // Rust waits up to ENSURE_FLEET_SPAWN_TIMEOUT_MS + WAIT_IDLE_CEILING_MS
  // (8s + 60s). Add slack so the sidecar never disconnects before Rust
  // finishes the batched flow.
  "/v1/ensure-fleet": 80_000,
};
const IPC_DEFAULT_TIMEOUT_MS = 8_000;
const TASK_STATUSES = ["todo", "in-progress", "blocked", "in-review", "complete", "cancelled"];

function resolveTimeoutForPath(path) {
  return IPC_ROUTE_TIMEOUTS_MS[path] ?? IPC_DEFAULT_TIMEOUT_MS;
}

const TOOLS = [
  {
    name: "lotus_list_fleet",
    description:
      "List registered Terminal cells across every Lotus workspace. " +
      "MUST filter is_alive=true before counting or reporting — dead cells " +
      "may be included. Default projection is compact but targetable " +
      "(pane_id, workspace_id, cwd, provider, status, is_alive, " +
      "last_output_preview). Use cwd exactly as returned; never invent " +
      "relative repo paths. Pass verbose=true only when you specifically " +
      "need display_name or session_id. Prefer the snapshot already " +
      "injected in <workspace-state> when its snapshot-at is <2s old. " +
      "The response also includes snapshot_age_ms: ms since the UI last " +
      "pushed the fleet (null = no workspace UI active yet). A large age " +
      "means no recent cell changes, not necessarily stale data.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: {
          type: "string",
          description:
            "Optional. Restrict the listing to a single workspace id. " +
            "Omit to list every fleet member across all workspaces.",
        },
        surface: {
          type: "string",
          enum: ["codespace", "canvas", "swarm"],
          description: "Optional. Restrict the listing to a Lotus surface.",
        },
        teamId: {
          type: "string",
          description: "Optional. Restrict swarm listings to one team id.",
        },
        verbose: {
          type: "boolean",
          description:
            "Optional. When true, return the full fleet member shape " +
            "(cwd, workspace_id, display_name, session_id). Default false " +
            "to keep the context window lean.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lotus_dispatch_to_cell",
    description:
      "Send a command / text to an existing Terminal cell, as if the user " +
      "typed it. MUST be preceded by lotus_wait_cell_idle on the same pane " +
      "if the cell was recently spawned or last dispatch has not finished " +
      "— otherwise input may be dropped or interpreted mid-output. " +
      "By default it submits with Enter (CR), which is safe for full-screen TUI agents. " +
      "Returns immediately; use lotus_read_cell_output to verify result.",
    inputSchema: {
      type: "object",
      required: ["paneId", "command"],
      properties: {
        paneId: {
          type: "string",
          description: "Target from lotus_list_fleet: exact pane_id, or a v2 address such as @swarm/workspace/team/member.",
        },
        command: {
          type: "string",
          description:
            "Text to write to the cell. Do not include a trailing newline unless " +
            "appendNewline=false.",
        },
        appendNewline: {
          type: "boolean",
          description: "Whether to append Enter so the command executes. Default true.",
        },
        enterKey: {
          type: "string",
          enum: ["lf", "cr"],
          description:
            "Line ending to append when appendNewline is true. Default cr; use lf only for tools that explicitly require it.",
        },
        submitAfterPaste: {
          type: "boolean",
          description:
            "Optional. When true, write the prompt first, then send a separate delayed Enter. " +
            "This avoids Claude Code TUI treating long prompts as staged pasted text. " +
            "Default is server auto-detect for Swarm TUI agents.",
        },
        submitDelayMs: {
          type: "number",
          description: "Optional delay before the separate delayed Enter when submitAfterPaste is active. Default 120ms, server capped.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lotus_read_cell_output",
    description:
      "Read the tail of a cell's output buffer. Use to verify the outcome " +
      "of a prior lotus_dispatch_to_cell, not for conversation. Keep tailBytes " +
      "small (2000–4000) unless you are hunting a specific error string.",
    inputSchema: {
      type: "object",
      required: ["paneId"],
      properties: {
        paneId: { type: "string" },
        tailBytes: {
          type: "number",
          description: "How many trailing bytes to return (default 4096, max 65536).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lotus_spawn_cell",
    description:
      "Spawn a new CodeSpace Terminal cell running the given agent CLI in the active " +
      "workspace. CodeSpace-only: not for Swarm team members already listed in lotus_list_fleet. Returns AS SOON AS the pane is registered — the shell or " +
      "agent inside may NOT be ready yet. You MUST call lotus_wait_cell_idle " +
      "on the returned pane id before any lotus_dispatch_to_cell. " +
      "Parallel spawns are fine; serialize only when one cell depends on " +
      "output from another. Verify existing alive cells via lotus_list_fleet " +
      "before spawning duplicates.",
    inputSchema: {
      type: "object",
      required: ["provider"],
      properties: {
        provider: {
          type: "string",
          enum: ["claude", "codex", "gemini", "opencode", "cursor", "copilot", "ccs-hss"],
          description: "Which agent to launch in the new cell.",
        },
        workspaceId: {
          type: "string",
          description: "Optional workspace target; defaults to the currently active workspace.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lotus_close_cell",
    description:
      "Terminate a Terminal cell: stops the PTY process and removes the pane " +
      "from its workspace. Use to clean up before lotus_spawn_cell when the " +
      "user's request implies a final-state count (e.g. 'launch one codex' " +
      "while two codex cells already exist → close the extra one). " +
      "Prefer closing the oldest / non-focused cells when multiple match. " +
      "Returns { ok, paneId }.",
    inputSchema: {
      type: "object",
      required: ["paneId"],
      properties: {
        paneId: {
          type: "string",
          description: "Pane id of the cell to close (see lotus_list_fleet).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lotus_ensure_fleet",
    description:
      "Reconcile the fleet to an exact final-state count of a single " +
      "provider in one atomic call. Replaces the list_fleet → spawn × N → " +
      "wait_cell_idle × N chain. The server computes the delta from the " +
      "live fleet snapshot, then:\n" +
      "  - If delta > 0: spawns the shortfall in parallel.\n" +
      "  - If delta < 0: closes the overflow (oldest in snapshot order first).\n" +
      "  - If delta = 0: returns immediately with no side effects.\n" +
      "Pass waitReady=true to also block until each newly-spawned cell " +
      "hits readiness=ready_shell|ready_tui|dialog (uses provider-aware default timeout). " +
      "PREFER this over the list/spawn/wait chain whenever the user asks " +
      "for a final-state count like 'launch 3 codex' or 'make sure we have " +
      "2 claude running'. Returns { ok, provider, requested, aliveBefore, " +
      "spawned, closed, ready, busy, errors }.",
    inputSchema: {
      type: "object",
      required: ["provider", "count"],
      properties: {
        provider: {
          type: "string",
          enum: ["claude", "codex", "gemini", "opencode", "cursor", "copilot", "ccs-hss"],
          description: "Which agent provider to reconcile.",
        },
        count: {
          type: "number",
          description:
            "Desired number of alive cells of this provider in the target " +
            "workspace (0-16). Final-state assertion, not additive.",
        },
        workspaceId: {
          type: "string",
          description:
            "Optional workspace target. When omitted, counts across ALL " +
            "workspaces and spawns into the currently active one.",
        },
        waitReady: {
          type: "boolean",
          description:
            "When true, block until each freshly-spawned cell reaches " +
            "readiness=ready_shell|ready_tui (or a dismissable dialog). Adds up to the " +
            "provider-aware wait timeout per pane, paralellized.",
        },
        waitTimeoutMs: {
          type: "number",
          description:
            "Optional override for the per-pane wait timeout (capped at " +
            "60000ms). Ignored when waitReady is false.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lotus_wait_cell_idle",
    description:
      "Block until a cell's output settles, then classify the state. " +
      "Returns { ok, idle, state, readiness, matched, suggestedInput, tail, waitedMs }. " +
      "`state` is the backwards-compatible coarse state: ready|dialog|busy. " +
      "`readiness` is the detailed state and is one of: \n" +
      "  - \"ready_shell\" — shell prompt detected ($ , % , >). Safe to dispatch with default enterKey.\n" +
      "  - \"ready_tui\" — full-screen agent TUI prompt detected (e.g. '? for shortcuts'). Safe to dispatch; use enterKey=\"cr\".\n" +
      "  - \"dialog\" — interactive prompt detected (e.g. 'press enter to continue', '(y/n)', 'continue?'). " +
      "    If `suggestedInput` is non-null, send it via lotus_dispatch_to_cell (typically \"\\r\"). " +
      "    If null, the dialog needs manual user interaction — STOP and report pane id + tail to user.\n" +
      "  - \"auth_required\" — explicit login/auth/approval text detected. STOP and report pane id + tail to user.\n" +
      "  - \"unknown_tui\" — output is dominated by ANSI/TUI redraw codes and no prompt/auth text was detected. Do NOT claim auth; retry once or ask the user to inspect the pane.\n" +
      "  - \"busy\" — timed out without matching; buffer is still streaming.\n" +
      "MANDATORY after lotus_spawn_cell and between back-to-back lotus_dispatch_to_cell calls on the same pane. " +
      "Call at most twice per pane per user turn — do not loop.",
    inputSchema: {
      type: "object",
      required: ["paneId"],
      properties: {
        paneId: { type: "string" },
        timeoutMs: {
          type: "number",
          description:
            "Max time to wait in ms (capped at 60000). When omitted, the " +
            "server picks a provider-aware default: ~15s for codex/gemini/" +
            "opencode, ~12s for cursor/copilot, ~10s for claude/ccs-hss, ~8s for " +
            "plain shell. Override only when you have a reason — shorter " +
            "defaults waste the retry budget on CLIs still booting.",
        },
        signatures: {
          type: "array",
          items: { type: "string" },
          description:
            "Override the ready signatures to look for (case-insensitive substrings). " +
            "When set, dialog patterns still apply as a fallback.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lotus_create_task",
    description:
      "Create a durable Bridge task scoped to a Lotus workspace. Use before " +
      "dispatching work that has more than two independent steps or is likely " +
      "to resurface in a future user turn. Return value includes task.id; pass " +
      "that id in the <task><context> envelope for delegated cells.",
    inputSchema: {
      type: "object",
      required: ["workspaceId", "title", "goal"],
      properties: {
        workspaceId: { type: "string" },
        title: {
          type: "string",
          description: "Short task title (max 120 chars).",
        },
        goal: {
          type: "string",
          description: "Concrete desired outcome (max 500 chars).",
        },
        knowledge: {
          type: "string",
          description: "Optional durable context or decisions for future turns.",
        },
        assignees: {
          type: "array",
          items: { type: "string" },
          description: "Optional cell/provider/role labels assigned to this task.",
        },
        status: {
          type: "string",
          enum: TASK_STATUSES,
          description: "Optional initial status. Defaults to todo.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lotus_update_task",
    description:
      "Update an existing Bridge task. Use for lifecycle transitions: " +
      "dispatch sent -> in-progress; worker done -> in-review; user ack -> complete.",
    inputSchema: {
      type: "object",
      required: ["workspaceId", "taskId"],
      properties: {
        workspaceId: { type: "string" },
        taskId: { type: "string" },
        title: { type: "string" },
        goal: { type: "string" },
        knowledge: { type: "string" },
        assignees: { type: "array", items: { type: "string" } },
        status: { type: "string", enum: TASK_STATUSES },
        teamId: { type: "string" },
        priority: { type: "string", enum: ["none", "low", "medium", "high"] },
        cellId: { type: ["string", "null"] },
        lastError: { type: ["string", "null"] },
        subtasks: { type: "array", items: { type: "object", additionalProperties: true } },
        intake: { type: "object", additionalProperties: true },
        blocker: { type: ["object", "null"], additionalProperties: true },
        feedbackEvents: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lotus_append_task_feedback_event",
    description:
      "Append one durable Swarm Task feedback-loop timeline event. Use for intake briefs, " +
      "HITL questions/answers, assignments, agent results, review verdicts, and revisions.",
    inputSchema: {
      type: "object",
      required: ["workspaceId", "taskId", "event"],
      properties: {
        workspaceId: { type: "string" },
        taskId: { type: "string" },
        event: {
          type: "object",
          required: ["id", "at", "actor", "kind", "summary"],
          additionalProperties: true,
          properties: {
            id: { type: "string" },
            at: { type: "number" },
            actor: { type: "string", enum: ["director", "human", "agent", "reviewer", "system"] },
            kind: { type: "string" },
            summary: { type: "string" },
            payload: {},
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lotus_record_task_intake",
    description: "Record the required Swarm Intake Gate brief and decision for a task.",
    inputSchema: {
      type: "object",
      required: ["workspaceId", "taskId", "briefXml", "confidence", "decision"],
      properties: {
        workspaceId: { type: "string" },
        taskId: { type: "string" },
        briefXml: { type: "string" },
        confidence: { type: "number" },
        decision: { type: "string", enum: ["assign", "ask-human", "blocked"] },
        summary: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lotus_record_assignment_plan",
    description: "Record the Director's assignment plan before dispatching work to Swarm Agent Panels.",
    inputSchema: {
      type: "object",
      required: ["workspaceId", "taskId", "summary", "assignments"],
      properties: {
        workspaceId: { type: "string" },
        taskId: { type: "string" },
        summary: { type: "string" },
        assignments: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lotus_record_agent_result",
    description: "Record one structured agent-result from a Swarm Agent Panel, including evidence and changed files.",
    inputSchema: {
      type: "object",
      required: ["workspaceId", "taskId", "member", "result"],
      properties: {
        workspaceId: { type: "string" },
        taskId: { type: "string" },
        member: { type: "string" },
        result: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lotus_request_task_review",
    description: "Move a Swarm Task to in-review and record a review request with evidence summary.",
    inputSchema: {
      type: "object",
      required: ["workspaceId", "taskId", "summary"],
      properties: {
        workspaceId: { type: "string" },
        taskId: { type: "string" },
        summary: { type: "string" },
        reviewer: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lotus_record_review_verdict",
    description: "Record reviewer verdict. PASS keeps the task reviewable/completable; FAIL requests revision.",
    inputSchema: {
      type: "object",
      required: ["workspaceId", "taskId", "verdict", "summary"],
      properties: {
        workspaceId: { type: "string" },
        taskId: { type: "string" },
        verdict: { type: "string", enum: ["PASS", "FAIL"] },
        summary: { type: "string" },
        reviewer: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lotus_complete_task",
    description: "Complete a Swarm Task only after intake, agent-result evidence, and PASS review verdict are recorded.",
    inputSchema: {
      type: "object",
      required: ["workspaceId", "taskId", "summary"],
      properties: {
        workspaceId: { type: "string" },
        taskId: { type: "string" },
        summary: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lotus_list_tasks",
    description:
      "List durable Bridge tasks for a workspace. Use to recover active work " +
      "before continuing a multi-turn task. Optional status/assignee filters reduce context.",
    inputSchema: {
      type: "object",
      required: ["workspaceId"],
      properties: {
        workspaceId: { type: "string" },
        status: { type: "string", enum: TASK_STATUSES },
        assignee: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "lotus_get_task",
    description: "Fetch one durable Bridge task by id within a workspace.",
    inputSchema: {
      type: "object",
      required: ["workspaceId", "taskId"],
      properties: {
        workspaceId: { type: "string" },
        taskId: { type: "string" },
      },
      additionalProperties: false,
    },
  },
];

async function readIpcConfig() {
  const raw = await readFile(IPC_CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (
    !parsed ||
    typeof parsed.port !== "number" ||
    typeof parsed.secret !== "string" ||
    !parsed.secret.length
  ) {
    throw new Error("lotus-mcp-ipc.json malformed");
  }
  return {
    port: parsed.port,
    secret: parsed.secret,
    pid: typeof parsed.pid === "number" ? parsed.pid : null,
  };
}

async function callLotus(path, body) {
  let cfg;
  try {
    cfg = await readIpcConfig();
  } catch (err) {
    const hint =
      err && err.code === "ENOENT"
        ? "Lotus desktop app does not appear to be running (lotus-mcp-ipc.json missing)."
        : err instanceof Error
          ? err.message
          : String(err);
    throw new Error(`Lotus IPC unavailable: ${hint}`);
  }

  const timeoutMs = resolveTimeoutForPath(path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${cfg.port}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.secret}`,
      },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Lotus IPC ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error(`Lotus IPC timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function textResult(value) {
  return {
    content: [
      {
        type: "text",
        text:
          typeof value === "string"
            ? value
            : JSON.stringify(value, null, 2),
      },
    ],
  };
}

function requireString(args, name) {
  if (!args || typeof args[name] !== "string" || args[name].length === 0) {
    throw new Error(`${name} is required`);
  }
  return args[name];
}

function optionalTaskStatus(args) {
  if (!args || args.status === undefined) return undefined;
  if (typeof args.status !== "string" || !TASK_STATUSES.includes(args.status)) {
    throw new Error(`status must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  return args.status;
}

function optionalStringArray(args, name) {
  if (!args || args[name] === undefined) return undefined;
  if (!Array.isArray(args[name]) || args[name].some((v) => typeof v !== "string")) {
    throw new Error(`${name} must be an array of strings`);
  }
  return args[name];
}

function nowMs() {
  return Date.now();
}

function eventId(prefix) {
  return `${prefix}_${nowMs()}_${Math.random().toString(36).slice(2, 8)}`;
}

function lifecycleEvent(kind, actor, summary, payload) {
  return {
    id: eventId(kind),
    at: nowMs(),
    actor,
    kind,
    summary,
    ...(payload === undefined ? {} : { payload }),
  };
}

async function appendTaskEvent(workspaceId, taskId, event) {
  return callLotus("/v1/tasks/append-feedback-event", {
    workspace_id: workspaceId,
    task_id: taskId,
    event,
  });
}

async function patchTask(workspaceId, taskId, patch) {
  return callLotus("/v1/tasks/update", {
    workspace_id: workspaceId,
    task_id: taskId,
    patch,
  });
}

function taskEvents(task) {
  return Array.isArray(task?.feedbackEvents) ? task.feedbackEvents : [];
}

function assertTaskCompletionReady(task) {
  if (!task?.intake) throw new Error("Cannot complete task before Swarm Intake Gate is recorded");
  const events = taskEvents(task);
  if (!events.some((event) => event.kind === "agent-result")) {
    throw new Error("Cannot complete task before at least one agent-result is recorded");
  }
  const latestReview = events.filter((event) => event.kind === "review-verdict").at(-1);
  if (!latestReview || latestReview?.payload?.verdict !== "PASS") {
    throw new Error("Cannot complete task before a PASS review verdict is recorded");
  }
}

/** Exported for testing — maps tool name → handler. */
export const handlers = {
  async lotus_list_fleet(args) {
    const workspaceId = args && typeof args.workspaceId === "string" ? args.workspaceId : undefined;
    const surface = args && ["codespace", "canvas", "swarm"].includes(args.surface) ? args.surface : undefined;
    const teamId = args && typeof args.teamId === "string" ? args.teamId : undefined;
    const verbose = !!(args && args.verbose === true);
    const payload = {};
    if (workspaceId) payload.workspace_id = workspaceId;
    if (surface) payload.surface = surface;
    if (teamId) payload.team_id = teamId;
    if (verbose) payload.verbose = true;
    const data = await callLotus("/v1/list-fleet", payload);
    return textResult(data);
  },
  async lotus_dispatch_to_cell(args) {
    if (!args || typeof args.paneId !== "string" || typeof args.command !== "string") {
      throw new Error("paneId and command are required strings");
    }
    const body = {
      pane_id: args.paneId,
      command: args.command,
      append_newline: args.appendNewline !== false,
    };
    if (args.enterKey === "lf" || args.enterKey === "cr") {
      body.enter_key = args.enterKey;
    }
    if (typeof args.submitAfterPaste === "boolean") {
      body.submit_after_paste = args.submitAfterPaste;
    }
    if (typeof args.submitDelayMs === "number" && Number.isFinite(args.submitDelayMs)) {
      body.submit_delay_ms = args.submitDelayMs;
    }
    const data = await callLotus("/v1/dispatch-to-cell", body);
    return textResult(data);
  },
  async lotus_read_cell_output(args) {
    if (!args || typeof args.paneId !== "string") {
      throw new Error("paneId is required");
    }
    const body = {
      pane_id: args.paneId,
      tail_bytes: typeof args.tailBytes === "number" ? args.tailBytes : undefined,
    };
    const data = await callLotus("/v1/read-cell-output", body);
    return textResult(data);
  },
  async lotus_spawn_cell(args) {
    if (!args || typeof args.provider !== "string") {
      throw new Error("provider is required");
    }
    const body = {
      provider: args.provider,
      workspace_id: typeof args.workspaceId === "string" ? args.workspaceId : undefined,
    };
    const data = await callLotus("/v1/spawn-cell", body);
    return textResult(data);
  },
  async lotus_close_cell(args) {
    if (!args || typeof args.paneId !== "string") {
      throw new Error("paneId is required");
    }
    const data = await callLotus("/v1/close-cell", { pane_id: args.paneId });
    return textResult(data);
  },
  async lotus_ensure_fleet(args) {
    if (!args || typeof args.provider !== "string") {
      throw new Error("provider is required");
    }
    if (typeof args.count !== "number" || !Number.isFinite(args.count)) {
      throw new Error("count is required and must be a finite number");
    }
    const body = {
      provider: args.provider,
      count: args.count,
    };
    if (typeof args.workspaceId === "string" && args.workspaceId.length > 0) {
      body.workspace_id = args.workspaceId;
    }
    if (args.waitReady === true) {
      body.wait_ready = true;
    }
    if (typeof args.waitTimeoutMs === "number" && Number.isFinite(args.waitTimeoutMs)) {
      body.wait_timeout_ms = args.waitTimeoutMs;
    }
    const data = await callLotus("/v1/ensure-fleet", body);
    return textResult(data);
  },
  async lotus_wait_cell_idle(args) {
    if (!args || typeof args.paneId !== "string") {
      throw new Error("paneId is required");
    }
    const body = {
      pane_id: args.paneId,
      timeout_ms: typeof args.timeoutMs === "number" ? args.timeoutMs : undefined,
      signatures: Array.isArray(args.signatures) ? args.signatures : undefined,
    };
    const data = await callLotus("/v1/wait-cell-idle", body);
    return textResult(data);
  },
  async lotus_create_task(args) {
    const body = {
      workspace_id: requireString(args, "workspaceId"),
      title: requireString(args, "title"),
      goal: requireString(args, "goal"),
    };
    if (typeof args.knowledge === "string") body.knowledge = args.knowledge;
    const assignees = optionalStringArray(args, "assignees");
    if (assignees) body.assignees = assignees;
    const status = optionalTaskStatus(args);
    if (status) body.status = status;
    const data = await callLotus("/v1/tasks/create", body);
    return textResult(data);
  },
  async lotus_update_task(args) {
    const patch = {};
    for (const key of ["title", "goal", "knowledge", "teamId", "priority"]) {
      if (typeof args?.[key] === "string") patch[key] = args[key];
    }
    const assignees = optionalStringArray(args, "assignees");
    if (assignees) patch.assignees = assignees;
    const status = optionalTaskStatus(args);
    if (status) patch.status = status;
    for (const key of ["cellId", "lastError", "blocker"]) {
      if (Object.prototype.hasOwnProperty.call(args ?? {}, key)) patch[key] = args[key];
    }
    for (const key of ["subtasks", "intake", "feedbackEvents"]) {
      if (args?.[key] !== undefined) patch[key] = args[key];
    }
    const data = await callLotus("/v1/tasks/update", {
      workspace_id: requireString(args, "workspaceId"),
      task_id: requireString(args, "taskId"),
      patch,
    });
    return textResult(data);
  },
  async lotus_append_task_feedback_event(args) {
    if (!args || typeof args.event !== "object" || args.event === null) {
      throw new Error("event is required");
    }
    const data = await callLotus("/v1/tasks/append-feedback-event", {
      workspace_id: requireString(args, "workspaceId"),
      task_id: requireString(args, "taskId"),
      event: args.event,
    });
    return textResult(data);
  },
  async lotus_record_task_intake(args) {
    const workspaceId = requireString(args, "workspaceId");
    const taskId = requireString(args, "taskId");
    const confidence = args?.confidence;
    if (typeof confidence !== "number" || !Number.isFinite(confidence)) throw new Error("confidence is required");
    const decision = requireString(args, "decision");
    if (!["assign", "ask-human", "blocked"].includes(decision)) throw new Error("decision must be assign, ask-human, or blocked");
    const intake = {
      briefXml: requireString(args, "briefXml"),
      confidence,
      decision,
      updatedAt: nowMs(),
    };
    const patch = { intake };
    if (decision === "blocked" || decision === "ask-human") {
      patch.status = "blocked";
      patch.blocker = {
        phase: "intake",
        type: decision === "ask-human" ? "human-input" : "ambiguity",
        reason: args.summary || "Swarm Intake Gate requires resolution before assignment.",
      };
    }
    const updated = await patchTask(workspaceId, taskId, patch);
    await appendTaskEvent(workspaceId, taskId, lifecycleEvent("intake-created", "director", args.summary || "Swarm Intake Gate recorded.", intake));
    return textResult(updated);
  },
  async lotus_record_assignment_plan(args) {
    const workspaceId = requireString(args, "workspaceId");
    const taskId = requireString(args, "taskId");
    if (!Array.isArray(args?.assignments)) throw new Error("assignments is required");
    const data = await appendTaskEvent(
      workspaceId,
      taskId,
      lifecycleEvent("assignment-plan-created", "director", requireString(args, "summary"), { assignments: args.assignments }),
    );
    return textResult(data);
  },
  async lotus_record_agent_result(args) {
    const workspaceId = requireString(args, "workspaceId");
    const taskId = requireString(args, "taskId");
    if (!args || typeof args.result !== "object" || args.result === null) throw new Error("result is required");
    const data = await appendTaskEvent(
      workspaceId,
      taskId,
      lifecycleEvent("agent-result", "agent", `${requireString(args, "member")}: ${args.result.summary || args.result.status || "result recorded"}`, {
        member: args.member,
        result: args.result,
      }),
    );
    return textResult(data);
  },
  async lotus_request_task_review(args) {
    const workspaceId = requireString(args, "workspaceId");
    const taskId = requireString(args, "taskId");
    await appendTaskEvent(workspaceId, taskId, lifecycleEvent("review-requested", "director", requireString(args, "summary"), { reviewer: args.reviewer }));
    const data = await patchTask(workspaceId, taskId, { status: "in-review" });
    return textResult(data);
  },
  async lotus_record_review_verdict(args) {
    const workspaceId = requireString(args, "workspaceId");
    const taskId = requireString(args, "taskId");
    const verdict = requireString(args, "verdict");
    if (!["PASS", "FAIL"].includes(verdict)) throw new Error("verdict must be PASS or FAIL");
    await appendTaskEvent(workspaceId, taskId, lifecycleEvent("review-verdict", "reviewer", requireString(args, "summary"), { verdict, reviewer: args.reviewer }));
    const data = verdict === "FAIL"
      ? await patchTask(workspaceId, taskId, { status: "blocked", blocker: { phase: "review", type: "verification-failed", reason: args.summary } })
      : await callLotus("/v1/tasks/get", { workspace_id: workspaceId, task_id: taskId });
    return textResult(data);
  },
  async lotus_complete_task(args) {
    const workspaceId = requireString(args, "workspaceId");
    const taskId = requireString(args, "taskId");
    const fetched = await callLotus("/v1/tasks/get", { workspace_id: workspaceId, task_id: taskId });
    const task = fetched?.task;
    assertTaskCompletionReady(task);
    await appendTaskEvent(workspaceId, taskId, lifecycleEvent("task-status-changed", "director", requireString(args, "summary"), { status: "complete" }));
    const data = await patchTask(workspaceId, taskId, { status: "complete", blocker: null });
    return textResult(data);
  },
  async lotus_list_tasks(args) {
    const body = {
      workspace_id: requireString(args, "workspaceId"),
    };
    const status = optionalTaskStatus(args);
    if (status) body.status = status;
    if (typeof args.assignee === "string" && args.assignee.length > 0) {
      body.assignee = args.assignee;
    }
    const data = await callLotus("/v1/tasks/list", body);
    return textResult(data);
  },
  async lotus_get_task(args) {
    const data = await callLotus("/v1/tasks/get", {
      workspace_id: requireString(args, "workspaceId"),
      task_id: requireString(args, "taskId"),
    });
    return textResult(data);
  },
};

function buildServer() {
  const server = new Server(
    { name: "lotus", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = handlers[name];
    if (!handler) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    }
    try {
      return await handler(args ?? {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: message }],
      };
    }
  });

  return server;
}

async function main() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only run main() when invoked as a script, not when imported by tests.
const isMainModule =
  typeof process !== "undefined" &&
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isMainModule) {
  main().catch((err) => {
    console.error("[lotus-mcp] fatal:", err);
    process.exit(1);
  });
}

export const __testables = {
  TOOLS,
  IPC_CONFIG_PATH,
  DEFAULT_IPC_CONFIG_PATH,
  resolveDiscoveryPath,
  callLotus,
  buildServer,
};

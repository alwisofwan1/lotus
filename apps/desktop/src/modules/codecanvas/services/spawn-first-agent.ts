import { nextAgentName, shuffled } from "@/lib/agent-catalog";
import type { AgentRunnerType } from "@/lib/agent-runtime";
import type { DetectedCli } from "@/lib/tauri-api";
import type { AgentDefinition } from "../types/canvas";
import { blankAgentDraft, buildAgentDefinition } from "./agent-draft";

/**
 * Spawn-first agent (ADR-0026 §3.5, CNVS model): "calling an agent = pick a CLI", with the name
 * assigned automatically. Synthesises a minimal, auto-named `AgentDefinition` for the chosen runner
 * — the handle is decoupled from any persona, so this rides the SAME spawn pipeline as a catalog
 * agent (`addAgentNode`/`createAgentNode`). A real persona stays an optional overlay.
 *
 * `takenNames` is the set of agent handles already on the canvas, so the auto-name is unique
 * per-canvas (deterministic, falls back to `Agent N` when the curated pool is exhausted).
 */
export function buildSpawnFirstAgentDefinition(
  runner: AgentRunnerType,
  takenNames: Iterable<string>,
  opts: {
    runnerCommand?: string;
    model?: string;
    /** Reasoning effort on the runner's own scale. Omitted leaves the CLI's default. */
    effort?: string;
    pool?: readonly string[];
    /**
     * `safe` or `full`. Omitted leaves the runner registry's own `skip_permissions` in
     * charge, which is the behaviour every caller had before a request could carry one.
     */
    permissionMode?: string;
  } = {},
): AgentDefinition {
  const draft = {
    ...blankAgentDraft(),
    // `pool` is the user's locale-resolved roster (voice-friendly handles); omitted = universal
    // default. (03b) Shuffled here, once, only when a pool is actually given — this is the
    // single choke point every spawn-first call site funnels through, so this one line covers
    // all seven of them instead of each caller needing its own shuffle. The omitted/default
    // case is left exactly as it was: no pool given still means the untouched
    // DEFAULT_AGENT_NAME_POOL, deterministic.
    name: nextAgentName(takenNames, opts.pool && shuffled(opts.pool)),
    runner,
    // CNVS-pure (ADR-0027): a launched runner has no baked role or model by default, so the blank
    // draft's default model is cleared and the CLI uses its own default. An explicit `model` override
    // (e.g. NL "spawn a claude opus agent") is honored when provided.
    model: opts.model?.trim() || "",
    ...(opts.effort?.trim() ? { effort: opts.effort.trim() } : {}),
    ...(opts.runnerCommand ? { runnerCommand: opts.runnerCommand } : {}),
    ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
  };
  return buildAgentDefinition(draft);
}

/**
 * Map a detected CLI to a kernel runner. Claude/Codex/Cursor have native runners (ADR-0027);
 * anything else spawns via the `custom` runner with its detected command.
 */
export function cliToRunnerSpec(cli: Pick<DetectedCli, "id" | "command">): { runner: AgentRunnerType; runnerCommand?: string } {
  if (cli.id === "claude") return { runner: "claude" };
  if (cli.id === "codex") return { runner: "codex" };
  if (cli.id === "cursor") return { runner: "cursor" };
  return { runner: "custom", runnerCommand: cli.command };
}

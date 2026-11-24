import { cleanNames } from "./agent-skill-prompt";
import { extractNoteAssetRefs, noteAssetUri, type NoteAssetRef } from "./note-assets";
import { PLAN_MD_FORMAT_INSTRUCTION } from "./plan-md-parser";

export interface AgentContextAsset extends NoteAssetRef {
  mime?: string;
  originalName?: string;
}

export interface AgentContextSource {
  type?: string;
  content?: unknown;
  /** For `handoff`/`context` sources: the agent that produced the artifact. */
  name?: string;
  /** For `context` (bus) sources: the artifact's named slot. */
  key?: string;
  /** For `context` (bus) sources: true when read from a different run than it was produced in. */
  stale?: boolean;
  /** Embedded durable Note Assets referenced by Rich Markdown Note content. */
  assets?: AgentContextAsset[];
  /** For `file` sources: the absolute path of a connected File Node. The agent reads the file itself. */
  path?: string;
}

export interface RunPromptParts {
  /** The agent's role/system prompt, from its definition. */
  rolePrompt: string;
  /**
   * Which operating contract to prepend. `headless` (default) = one-shot,
   * non-interactive graph worker. `live` = interactive terminal persona a human
   * watches and other agents can read/hand off to. See ADR-0022.
   */
  operatingMode?: "headless" | "live";
  /** Skill names to apply (invoked via the Skill tool at run time). */
  skills?: string[];
  /** Upstream nodes wired into this agent — only Note sources contribute context. */
  context?: AgentContextSource[];
  /** Names of all agents on the canvas — the authoritative owner vocabulary for plan.md. */
  roster?: string[];
  /** false = read-only/safe mode; agent is told not to mutate. undefined/true = full access. */
  skipPermissions?: boolean;
  /** true = this run authors plan.md (Planner role); gates the plan-format + roster blocks. */
  emitsPlan?: boolean;
}

const BLOCK_SEPARATOR = "\n\n---\n\n";

// The harness contract every canvas agent inherits: headless, one-shot, no human in the loop.
// Without this, autonomy depended on each definition restating it — so minimal definitions
// would stop to ask clarifying questions instead of finishing the run. Agents are
// standalone-but-composable (ADR 0010): coordination rides injected structured context, not
// a free-text docs/agent-team/ convention.
const HEADLESS_PREAMBLE = `# Operating mode
You are a headless agent running on a visual canvas, one-shot and non-interactive. There is no human available to answer questions during this run. Do NOT ask for clarification or wait for confirmation — make the most reasonable assumption, state it in one line, and finish the task autonomously. Any context you need is provided inline below (connected notes, upstream handoffs, shared context); use it, and finish with a clear structured summary so downstream agents can build on your work.`;

// The contract for a live terminal persona (ADR-0022): a human is watching and may
// steer, and other agents can read this terminal and hand off to it. Unlike the headless
// preamble, it permits a brief clarifying question when a choice is genuinely ambiguous —
// the human is present, so silently guessing on a costly fork is the worse failure mode.
const LIVE_PREAMBLE = `# Operating mode
You are a live agent in an interactive terminal on a visual canvas. A human is watching and may steer you. Prefer to keep going autonomously, but you MAY ask a brief clarifying question when a choice is genuinely ambiguous and costly to get wrong. Other agents can read your terminal and hand off to you. Finish with a clear structured summary so downstream agents can build on your work.`;

const READONLY_NOTICE = `# Permissions
You are in READ-ONLY (safe) mode. Inspect and report only: do NOT create, edit, or delete files, and do NOT run mutating commands.`;

function skillBlock(skills: string[]): string {
  const names = cleanNames(skills);
  if (names.length === 0) return "";
  return `# Skills to apply\nUse these skills for this task where relevant (invoke each via the Skill tool): ${names.join(", ")}.`;
}

// The authoritative owner vocabulary. The canvas binds plan owners to agents by name, so the Lead
// must use the real teammate names verbatim — this removes the guesswork that caused 0/N progress.
function rosterBlock(roster: string[]): string {
  const names = cleanNames(roster);
  if (names.length === 0) return "";
  return `# Teammates on the canvas\nThese agents exist on the canvas. When you set a step owner in plan.md, use one of these names EXACTLY (verbatim, no abbreviation): ${names.join(", ")}.`;
}

function asText(content: unknown): string {
  return typeof content === "string" ? content.trim() : "";
}

function noteAssetManifest(markdown: string, explicitAssets?: AgentContextAsset[]): string {
  const refs = explicitAssets && explicitAssets.length > 0 ? explicitAssets : extractNoteAssetRefs(markdown);
  if (refs.length === 0) return "";
  const seen = new Set<string>();
  const lines = refs.flatMap((asset) => {
    if (!asset.id || seen.has(asset.id)) return [];
    seen.add(asset.id);
    const originalName = "originalName" in asset ? asset.originalName : undefined;
    const mime = "mime" in asset ? asset.mime : undefined;
    const label = originalName || asset.alt || "embedded image";
    const meta = mime ? ` (${mime})` : "";
    return `- ${asset.id}: ${label}${meta} (${noteAssetUri(asset.id)})`;
  });
  return lines.length > 0 ? `Embedded images:\n${lines.join("\n")}` : "";
}

function noteContextText(source: AgentContextSource): string {
  const markdown = asText(source.content);
  if (!markdown) return "";
  const manifest = noteAssetManifest(markdown, source.assets);
  return manifest ? `${markdown}\n\n${manifest}` : markdown;
}

// Connected nodes feed three kinds of context: static Note content (shared spec), live
// Handoff artifacts (an upstream agent's result this run, N2), and Context Bus artifacts
// (named outputs any agent published to a shared bus, N3).
function contextBlock(sources: AgentContextSource[]): string {
  const blocks: string[] = [];
  const notes = sources.filter((s) => s.type === "note").map(noteContextText).filter(Boolean);
  if (notes.length > 0) {
    blocks.push(`# Shared context (from connected notes)\n\n${notes.join(BLOCK_SEPARATOR)}`);
  }
  const files = sources.filter((s) => s.type === "file" && s.path).map((s) => `- ${s.path}`);
  if (files.length > 0) {
    blocks.push(`# Files on the board (connected File Nodes)\n\nThe human has these files open next to you. Read them from disk; their contents are not included here.\n\n${files.join("\n")}`);
  }
  for (const source of sources) {
    if (source.type !== "handoff") continue;
    const summary = asText(source.content);
    if (!summary) continue;
    const from = asText(source.name) || "upstream agent";
    blocks.push(`# Handoff from ${from}\n\n${summary}`);
  }
  for (const source of sources) {
    if (source.type !== "context") continue;
    const value = asText(source.content);
    if (!value) continue;
    const key = asText(source.key) || "artifact";
    const from = asText(source.name) || "an agent";
    const warn = source.stale ? " ⚠ (from an earlier run — may be outdated)" : "";
    blocks.push(`# Context: ${key} (from ${from})${warn}\n\n${value}`);
  }
  return blocks.join(BLOCK_SEPARATOR);
}

/** Assembles a run prompt: operating contract → governance → (plan+roster if emitsPlan) → skills → context → role. */
export function buildAgentRunPrompt(parts: RunPromptParts): string {
  return [
    parts.operatingMode === "live" ? LIVE_PREAMBLE : HEADLESS_PREAMBLE,
    parts.skipPermissions === false ? READONLY_NOTICE : "",
    parts.emitsPlan ? PLAN_MD_FORMAT_INSTRUCTION : "",
    parts.emitsPlan ? rosterBlock(parts.roster ?? []) : "",
    skillBlock(parts.skills ?? []),
    contextBlock(parts.context ?? []),
    parts.rolePrompt.trim(),
  ]
    .filter(Boolean)
    .join(BLOCK_SEPARATOR);
}

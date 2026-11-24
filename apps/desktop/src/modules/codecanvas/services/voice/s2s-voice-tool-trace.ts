import { isDevBuild } from "@/lib/build-env";
import type { S2sToolCall } from "./s2s-stream-bridge";

const MAX_PREVIEW = 96;

export interface VoiceToolTraceEntry {
  id: string;
  tool: string;
  ok: boolean;
  heardTarget?: string;
  resolvedTarget?: string;
  preview?: string;
  speak?: string;
  error?: string;
  contextVersion?: number;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function truncate(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= MAX_PREVIEW ? compact : `${compact.slice(0, MAX_PREVIEW - 1)}…`;
}

function resolvedFromSummary(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  const match = summary.match(/^(?:Dispatch to|Say to|Focus|Open|Navigate|Recover|Make lead)\s+(.+)$/i);
  return match?.[1]?.trim();
}

function previewFromArgs(args: Record<string, unknown>): string | undefined {
  return str(args.message) ?? str(args.task) ?? str(args.topic) ?? str(args.url) ?? str(args.nodeType) ?? str(args.runner);
}

function traceToolLabel(name: string): string {
  return name.replace(/_/g, " ");
}

/** Dev-only switch. Kept injectable so tests can prove production remains quiet. */
export function isVoiceToolTraceEnabled(dev = isDevBuild()): boolean {
  return dev;
}

/**
 * Compact dev diagnostic for realtime voice tool calls. Never include node ids/UIDs or raw internal
 * result payloads; the goal is to show what the model asked for and what Lotus resolved it to.
 */
export function buildVoiceToolTraceEntry(call: S2sToolCall, result: unknown, contextVersion?: number): VoiceToolTraceEntry {
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const ok = record.ok !== false;
  const summary = str(record.summary);
  const entry: VoiceToolTraceEntry = {
    id: call.callId,
    tool: traceToolLabel(call.name),
    ok,
    ...(str(call.args.target) ? { heardTarget: str(call.args.target) } : {}),
    ...(resolvedFromSummary(summary) ? { resolvedTarget: resolvedFromSummary(summary) } : {}),
    ...(previewFromArgs(call.args) ? { preview: truncate(previewFromArgs(call.args)!) } : {}),
    ...(str(record.speak) ? { speak: str(record.speak) } : {}),
    ...(str(record.error) ? { error: str(record.error) } : {}),
    ...(contextVersion ? { contextVersion } : {}),
  };
  return entry;
}

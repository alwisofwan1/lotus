import type { S2sLatencyEventInput } from "./s2s-latency-tracker";
import type { VoiceToolTraceEntry } from "./s2s-voice-tool-trace";

const MAX_EVENTS = 40;

export interface S2sVoiceDiagnosticEvent extends VoiceToolTraceEntry {
  at: number;
  contextVersion?: number;
}

export interface S2sVoiceHealthDiagnosticEvent {
  kind: "health";
  at: number;
  socket?: string;
  mic?: string;
  playback?: string;
  tools?: string;
  audioDeltas?: number;
  issue?: string;
  lastTool?: string;
}

export interface S2sVoiceLatencyDiagnosticEvent extends S2sLatencyEventInput {
  kind: "latency";
  at: number;
}

export interface S2sVoiceDiagnosticsSnapshot {
  events: S2sVoiceDiagnosticEvent[];
  healthEvents: S2sVoiceHealthDiagnosticEvent[];
  latencyEvents: S2sVoiceLatencyDiagnosticEvent[];
}

let events: S2sVoiceDiagnosticEvent[] = [];
let healthEvents: S2sVoiceHealthDiagnosticEvent[] = [];
let latencyEvents: S2sVoiceLatencyDiagnosticEvent[] = [];

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

export function recordS2sVoiceDiagnostic(entry: VoiceToolTraceEntry, contextVersion?: number, now = Date.now()): void {
  events = [{ ...entry, at: now, ...(contextVersion ? { contextVersion } : {}) }, ...events].slice(0, MAX_EVENTS);
}

export function recordS2sVoiceHealthDiagnostic(
  entry: Omit<S2sVoiceHealthDiagnosticEvent, "kind" | "at">,
  now = Date.now(),
): void {
  const event: S2sVoiceHealthDiagnosticEvent = {
    kind: "health",
    at: now,
    ...(entry.socket ? { socket: clean(entry.socket) } : {}),
    ...(entry.mic ? { mic: clean(entry.mic) } : {}),
    ...(entry.playback ? { playback: clean(entry.playback) } : {}),
    ...(entry.tools ? { tools: clean(entry.tools) } : {}),
    ...(typeof entry.audioDeltas === "number" ? { audioDeltas: entry.audioDeltas } : {}),
    ...(entry.issue ? { issue: clean(entry.issue) } : {}),
    ...(entry.lastTool ? { lastTool: clean(entry.lastTool) } : {}),
  };
  healthEvents = [event, ...healthEvents].slice(0, MAX_EVENTS);
}

function finiteWhole(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(0, Math.round(value)));
}

export function recordS2sVoiceLatencyDiagnostic(
  entry: S2sLatencyEventInput,
  now = Date.now(),
): void {
  const event: S2sVoiceLatencyDiagnosticEvent = {
    kind: "latency",
    at: now,
    milestone: entry.milestone,
    turn: finiteWhole(entry.turn, 1_000_000),
    ...(typeof entry.elapsedFromSpeechEndMs === "number"
      ? { elapsedFromSpeechEndMs: finiteWhole(entry.elapsedFromSpeechEndMs, 600_000) }
      : {}),
    ...(typeof entry.durationMs === "number"
      ? { durationMs: finiteWhole(entry.durationMs, 600_000) }
      : {}),
  };
  latencyEvents = [event, ...latencyEvents].slice(0, MAX_EVENTS);
}

export function getS2sVoiceDiagnosticsSnapshot(): S2sVoiceDiagnosticsSnapshot {
  return {
    events: [...events],
    healthEvents: [...healthEvents],
    latencyEvents: [...latencyEvents],
  };
}

export function resetS2sVoiceDiagnosticsForTests(): void {
  events = [];
  healthEvents = [];
  latencyEvents = [];
}

export function stringifyS2sVoiceDiagnostics(snapshot: S2sVoiceDiagnosticsSnapshot = getS2sVoiceDiagnosticsSnapshot()): string {
  return [...snapshot.events, ...snapshot.healthEvents, ...snapshot.latencyEvents]
    .map((event) => JSON.stringify(event))
    .join("\n");
}

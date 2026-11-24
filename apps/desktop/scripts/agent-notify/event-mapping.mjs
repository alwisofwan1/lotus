// Canonical event → status mapping. The watcher trusts what the script writes
// and does not re-derive status, so this table is the source of truth.

/**
 * @typedef {Object} EventMapping
 * @property {"idle" | "needs-input" | "error" | "running" | "ended"} status
 * @property {string} defaultTitle
 */

const FALLBACK = Object.freeze({ status: "idle", defaultTitle: "Update" });

const EVENT_TABLE = new Map([
  ["stop",            { status: "idle",        defaultTitle: "Finished working" }],
  ["agent-response",  { status: "idle",        defaultTitle: "Finished working" }],
  ["after-agent",     { status: "idle",        defaultTitle: "Finished working" }],
  ["notification",    { status: "needs-input", defaultTitle: "Needs input" }],
  ["needs-input",     { status: "needs-input", defaultTitle: "Needs input" }],
  ["error",           { status: "error",       defaultTitle: "Error" }],
  ["session-start",   { status: "running",     defaultTitle: "Working" }],
  // `UserPromptSubmit`, wired 2026-08-08. `running` for the same reason the tool events
  // are: codespace filters this stream on status alone, and a turn beginning is neither a
  // completion nor a failure. The title names the speaker, because this is the one event
  // whose body is the operator's own words rather than the agent's.
  ["prompt-submit",   { status: "running",     defaultTitle: "You" }],
  ["before-agent",    { status: "running",     defaultTitle: "Working" }],
  ["session-end",     { status: "ended",       defaultTitle: "Session ended" }],
  // Narration tool events (plans/voice-narration-layer). All three stay "running" on purpose:
  // codespace's useAgentHookEvents filters this stream on STATUS alone and never on the event
  // name, reading "idle" as "the agent completed" and "error" as "the agent failed". A tool drop
  // carrying either would mislabel the whole agent on every tool call. "running" is skipped there.
  // Tool FAILURE is therefore carried by the event name, not by the status.
  ["tool-pre",         { status: "running",     defaultTitle: "Tool" }],
  ["tool-post",        { status: "running",     defaultTitle: "Tool" }],
  ["tool-post-failed", { status: "running",     defaultTitle: "Tool" }],
]);

/**
 * Map an event name to its `{ status, defaultTitle }`. Case-insensitive,
 * whitespace-tolerant. Unknown or empty events fall back to `idle / "Update"`.
 *
 * @param {unknown} event
 * @returns {EventMapping}
 */
export function mapEventToStatus(event) {
  if (typeof event !== "string") return { ...FALLBACK };
  const normalized = event.trim().toLowerCase();
  if (!normalized) return { ...FALLBACK };
  const hit = EVENT_TABLE.get(normalized);
  return hit ? { ...hit } : { ...FALLBACK };
}

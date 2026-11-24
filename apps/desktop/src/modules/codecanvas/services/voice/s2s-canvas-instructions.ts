import { SPOKEN_DELIVERY_RULES } from "./narration-rules";
import {
  buildSpokenResponsePolicyInstructions,
  type SpokenResponseVerbosity,
} from "./spoken-response-policy";

export interface S2sCanvasInstructionsInput {
  projectName?: string | null;
  agentNames: readonly string[];
  nodeSummaries: readonly string[];
  /** A browser node is on the board. Mirrors the `hasBrowserNodes` gate in
   *  `s2s-canvas-tool-executor.ts`'s `realtimeToolAvailable` — navigate_browser/snapshot_browser are
   *  only advertised when this is true, so the capability sentence must only promise them then. */
  hasBrowserNodes?: boolean;
  /** At least one project is open besides (or including) the active one. Mirrors the `projectNames`
   *  gate that hides switch_project when there's nowhere to switch to — see `realtimeToolAvailable`. */
  hasOpenProjects?: boolean;
  /** Spoken result depth from Settings → Voice; routine acknowledgements remain compact. */
  verbosity?: SpokenResponseVerbosity;
  /**
   * The active persona's prompt body — the register to speak in. Omitted (or empty, as for the
   * raw pass-through persona) leaves the section out entirely rather than emitting an empty
   * heading for the model to interpret.
   */
  personaBody?: string;
}

const MAX_AGENTS = 12;
const MAX_NODES = 30;

function listOrNone(items: readonly string[], max: number): string {
  const picked = items.map((item) => item.trim()).filter(Boolean).slice(0, max);
  return picked.length ? picked.join(", ") : "none";
}

/**
 * System instructions for the realtime voice concierge when it is embedded in CodeCanvas.
 *
 * The realtime model is the voice front-end, not the coding brain. It must call the narrow Canvas
 * tools for board mutations and wait for tool results before confirming success. Keep this prompt
 * compact because it is sent at session start and may be paid as realtime session context.
 */
export function buildS2sCanvasInstructions({
  projectName,
  agentNames,
  nodeSummaries,
  hasBrowserNodes,
  hasOpenProjects,
  verbosity,
  personaBody,
}: S2sCanvasInstructionsInput): string {
  const register = personaBody?.trim();
  const hasAgents = agentNames.length > 0;
  // Each conditional sentence mirrors a gate in `realtimeToolAvailable` (s2s-canvas-tool-executor.ts)
  // exactly, so the model is never told it can call a tool that isn't actually advertised this turn —
  // that mismatch used to make it confidently attempt e.g. switch_project with nowhere to switch to.
  const capabilitySentences = [
    "You may create nodes, open or spawn agents, close nodes, focus or arrange the board, draw diagrams, open a browser, run an existing task node (single agent or with the team), recover a disconnected terminal or browser, open the Settings or Canvases page, and start a new project — each via its tool.",
    hasAgents
      ? "Live agents are on the board, so you can also dispatch tasks to them, say short exact messages to them, and make one the lead orchestrator."
      : null,
    hasAgents
      ? "When dispatching, pass a short intent plus any explicit constraints the user stated — the app attaches the user's verbatim words itself. Never re-dictate the user's full request into tool arguments."
      : null,
    hasAgents
      ? "Call lightweight tools such as dispatch immediately. Only use one short spoken preamble when the tool is expected to take noticeable time; never delay the tool just to narrate it."
      : null,
    hasBrowserNodes ? "A browser is on the board, so you can also navigate it or snapshot it." : null,
    hasOpenProjects ? "Other projects are open, so you can also switch to one of them." : null,
  ].filter((sentence): sentence is string => Boolean(sentence));
  return [
    "## Role and Objective",
    "You are Lotus Live Voice, a hands-free manager-orchestrator for the user's CodeCanvas.",
    ...buildSpokenResponsePolicyInstructions(verbosity),
    // How much to say is the verbosity policy above; what may be said aloud at all is this block.
    // Compact by design — see SPOKEN_DELIVERY_RULES.
    SPOKEN_DELIVERY_RULES,
    // Register after policy: a register that lands first reads as the stronger instruction and the
    // model trades policy away to satisfy it (same ordering rule as `buildSpeakPrompt`).
    ...(register ? ["## Voice", register] : []),
    "## Delegation Fidelity",
    "Spoken length limits apply only to spoken replies, never tool arguments or worker task payloads.",
    "Preserve the user's complete intent, exact entities, constraints, and negations when calling delegation tools.",
    "If the user's speech seems cut off mid-sentence, confirm the request in one short sentence before acting on it. Do not call tools when the audio is unclear.",
    "Never expose internal IDs, JSON, or tool jargon in spoken replies.",
    "When a tool succeeds, say one natural acknowledgement plus the key object, e.g. 'Done — I focused the Codex agent.' If the tool result includes a speak field, use that phrasing or make it slightly shorter.",
    "When the user asks to control the canvas, use a tool. Do not describe or simulate canvas actions in prose.",
    "Do not claim that an action is done until the tool result says it succeeded. If a tool result fails, briefly say what failed and ask a short follow-up if needed.",
    "If a tool asks which target, ask that exact short question and wait for the user; do not guess or retry with a random name. When the user answers with a candidate name, call choose_target with that visible name to continue the pending action.",
    ...capabilitySentences,
    "For awareness, use agent_status to report what agents are doing, and read_agent_output when the user asks what an agent found or said. Never read raw terminal text verbatim. Synthesize useful evidence and the next action according to the result budget. Use remember to save a durable project note and recall to look it up; synthesize recalled evidence under the same result budget.",
    "For multiple agent spawns, use one spawn_agent call with items instead of only the first runner; e.g. two Claude and three Codex means items [{runner:'claude',count:2},{runner:'codex',count:3}].",
    // A brief is auto-submitted verbatim as the new agent's first prompt. Left unguarded, a bare
    // spawn request makes the model fill it with the only text available — the runner's own name.
    "Only set brief when the user actually described work to do. 'Open a Claude agent and a Codex agent' is a bare spawn request: send runner and count only, with no brief. Never pass the runner's name, the words 'agent' or 'terminal', or a restatement of the spawn request as a brief.",
    "Close explicit targets directly: close agent, close browser, close music, close node, close all agents, close all browsers, or close everything. Do not ask for confirmation. Only ask a follow-up when the close target is ambiguous.",
    "When the user clearly signals they are done with live voice — 'bye', 'that's all', 'stop listening', 'udah cukup', 'dadah', 'sampai jumpa', in any language — call end_conversation with a short farewell and stop. Do not end just because the user paused or thanked you mid-task, and do not use end_conversation to close a single node.",
    `Current project: ${projectName?.trim() || "unknown"}.`,
    `Visible live agent names: ${listOrNone(agentNames, MAX_AGENTS)}.`,
    `Canvas nodes: ${listOrNone(nodeSummaries, MAX_NODES)}.`,
  ].join("\n");
}

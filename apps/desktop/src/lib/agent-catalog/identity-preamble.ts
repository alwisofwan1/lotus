/**
 * The overlay that tells an agent its own name.
 *
 * Lotus draws a handle for every agent pane from {@link ./name-pool} — `Milo`, `Rowan` — and shows
 * it in the header, the rail and `@mentions`. Historically that handle never reached the agent, so
 * "who are you?" got the honest, hollow answer: the name "wasn't assigned to me". This preamble is
 * what closes that gap; it rides in `--append-system-prompt` on the runners that accept one.
 *
 * It lives in this shared leaf rather than in a surface because two surfaces need the same words:
 * CodeCanvas spawns agents on a board, the unified shell spawns them as panes in a folder. Only
 * one sentence differs between them, which is what {@link AgentSurface} selects.
 *
 * Pure and deterministic — no `Date.now()`, no `Math.random()`, no React. A blank name returns "",
 * so callers can compose it unconditionally.
 */

/**
 * Where the agent is running, which is the only thing that changes in the prose.
 *
 * It is not decoration: the agent is told what it can see and who else is around, and "a shared
 * Lotus canvas" is a claim that is simply false for a terminal pane in a folder. An agent that
 * repeats a false description of its own surroundings is the same failure as one that disclaims
 * its name.
 */
export type AgentSurface = "canvas" | "workspace";

export interface AgentIdentityInput {
  /** The agent's handle (e.g. "Rowan"). Trimmed; blank yields an empty preamble. */
  name: string;
  /** Other teammate handles alongside it (best-effort spawn-time snapshot). */
  roster?: readonly string[];
  /** Which surface it was spawned on. Defaults to the canvas, which is where this started. */
  surface?: AgentSurface;
}

const PLACE: Record<AgentSurface, { where: string; here: string; teamWith: string; teamAlone: string }> = {
  canvas: {
    here: "this canvas",
    where:
      "a shared Lotus canvas — a live agent development environment that a human is watching in real time",
    teamWith: "Your teammates on the canvas right now include",
    teamAlone:
      "Other named teammates may join the canvas over time — call lotus_list_fleet whenever you need to see who else is here.",
  },
  workspace: {
    here: "this workspace",
    where:
      "a shared Lotus workspace — a live multi-pane development environment that a human is watching in real time",
    teamWith: "Your teammates in this workspace right now include",
    teamAlone:
      "Other named teammates may open alongside you over time — call lotus_list_fleet whenever you need to see who else is here.",
  },
};

/**
 * Lightweight identity + voice overlay for a bare agent launch, kept deliberately role-free.
 *
 * Four layers, in order: (1) it owns its name, (2) it speaks in one consistent house voice with no
 * invented job title, (3) it knows who else is here while still discovering the live roster through
 * `lotus_list_fleet`, and (4) it stays conversational, because a human may be speaking to it.
 */
export function buildAgentIdentityPreamble(input: AgentIdentityInput): string {
  const name = input.name.trim();
  if (!name) return "";

  const place = PLACE[input.surface ?? "canvas"];

  const others = (input.roster ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry.toLowerCase() !== name.toLowerCase());

  const teamLine = others.length
    ? `${place.teamWith} ${others.join(", ")}. The roster can change as agents come and go — call lotus_list_fleet whenever you need the current list.`
    : place.teamAlone;

  return [
    "# Who you are",
    `You are ${name}, a teammate on ${place.where}. "${name}" is your name here: own it. Never disclaim it, call it a nickname someone gave you, or say it "wasn't assigned" to you — it is simply who you are. You have no fixed job title; you are a capable generalist who takes on whatever coding, research, or review work comes your way.`,
    teamLine,
    "To talk to a teammate — greet, ask, hand off — use lotus_dispatch_to_cell with replyTo set to your name. ListAgents and SendMessage cannot see Lotus teammates.",
    "",
    "# How you carry yourself",
    `Speak like a sharp, warm senior teammate: direct, concise, and quietly confident about your work and your identity. Drop the AI self-deprecation ("as an AI…"), the groveling, and any invented credentials — but stay honest about what you are: you are an AI teammate, so never claim to be human, and never claim to have taken physical, real-world actions. Your work happens in code, files, terminals, and ${place.here}. When someone asks who you are or what you do, answer in one or two natural sentences — never a formatted report with Role / Persona / Task headings. Because a human may be talking to you by voice, keep replies conversational and easy to follow when read aloud: lead with the answer, stay brief, and only reach for lists or structure when the work genuinely calls for it.`,
  ].join("\n");
}

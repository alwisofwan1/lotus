/**
 * Whether a spoken message to an agent needs the user's "yes" before it is sent (Code and Canvas
 * Live Voice). The agent runs it with its own permissions, so this is the last point a misheard word
 * can be stopped. Two layers, so one catches what the other misses: the words below, and the voice
 * model's own `risky` judgement for wording no list knows.
 */

/**
 * When Live Voice asks for the spoken yes (Settings › Voice › Live). "always": anything that changes
 * something. "auto": only what is hard to undo or reaches other people. "off": never.
 */
export type ConfirmMode = "always" | "auto" | "off";

/** `high` is hard to undo or leaves this machine; only it is asked about under "auto". */
const RISKY_ASKS: [RegExp, string, "high" | "medium"][] = [
  [/\bpush\b/i, "push", "high"],
  [/\bmerge\b/i, "merge", "high"],
  [/\b(deploy|release|rilis|publish|terbitkan|upload|unggah|naikkan)\b/i, "deploy or publish", "high"],
  [/\b(delete|remove|hapus|buang|rm|drop|wipe|bersihkan|kosongkan|clean|reset)\b/i, "delete something", "high"],
  // Only outside channels: "kirim ke Codex" / "send a message to Kai" is how a dispatch itself is said.
  [/\b(send|kirim|post|reply|balas)\b.*\b(slack|email|e-mail|discord|comment|komentar)\b/i, "send something", "high"],
  [/\b(close|tutup)\b.*\b(pr|pull request|issue|ticket|tiket)\b/i, "close a PR or issue", "high"],
  [/\b(open|create|buat|bikin|buka)\b.*\b(pr|pull request)\b|\bgh (pr|issue|release) (create|merge|close|comment|edit)\b/i, "change GitHub", "high"],
  [/\bcommit\b/i, "commit", "medium"],
];

/** What the message asks for that needs a yes under `mode`, in a few words; null when it can go. */
export function riskyAsk(text: string, modelRisk: unknown = "none", mode: ConfirmMode = "always"): string | null {
  if (mode === "off") return null;
  const hit = RISKY_ASKS.find(([pattern, , level]) => (mode === "always" || level === "high") && pattern.test(text));
  if (hit) return hit[1];
  // The model's own judgement covers wording no list knows ("taruh di GitHub"): "high" under both
  // modes, "local" (a commit, an edit) only under "always".
  const risk = readModelRisk(modelRisk);
  if (risk === "high") return "do something that leaves this computer or is hard to undo";
  return mode === "always" && risk === "local" ? "change something" : null;
}

/** The model's `risky` value; an old-style `true` counts as high, so a stale model fails safe. */
function readModelRisk(value: unknown): "none" | "local" | "high" {
  if (value === "high" || value === true) return "high";
  return value === "local" ? "local" : "none";
}

/** The `risky` tool parameter both surfaces advertise on their message tools. */
export const RISKY_MESSAGE_PARAM = {
  type: "string",
  enum: ["none", "local", "high"],
  description:
    "How risky the message is. high: it leaves this computer or is hard to undo — push, merge, upload, deploy, publish, delete, clean up, send or post anything, open or close a PR or issue. local: it changes only local files — edit, write code, commit. none: reading, explaining, answering.",
} as const;

/** The `confirm` tool parameter: the second call, after the user's yes. */
export const CONFIRM_MESSAGE_PARAM = { type: "boolean", description: "True only when the user has just said yes to sending this." } as const;

export function clipQuote(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The message tools with `risky` and `confirm` added, for a surface whose tool schema is shared elsewhere. */
export function withRiskyMessageParams<T extends { name: string; parameters?: unknown }>(tools: T[], names: readonly string[]): T[] {
  return tools.map((tool) => {
    const parameters = tool.parameters as { properties?: Record<string, unknown> } | undefined;
    if (!names.includes(tool.name) || !parameters?.properties) return tool;
    return { ...tool, parameters: { ...parameters, properties: { ...parameters.properties, risky: RISKY_MESSAGE_PARAM, confirm: CONFIRM_MESSAGE_PARAM } } };
  });
}

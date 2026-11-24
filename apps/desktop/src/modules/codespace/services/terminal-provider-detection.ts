const KNOWN_PROVIDERS = new Set([
  "claude",
  "codex",
  "gemini",
  "opencode",
  "cursor",
  "copilot",
  "ccs-hss",
]);

type KnownProvider = "claude" | "codex" | "gemini" | "opencode" | "cursor" | "copilot" | "ccs-hss";
type ProviderOrShell = KnownProvider | "shell";

export function providerFromAgentCommand(
  agentCommand: string | undefined,
): ProviderOrShell | undefined {
  if (!agentCommand) return undefined;
  const normalized = agentCommand.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized === "ccs hss" || normalized.startsWith("ccs hss ")) return "ccs-hss";
  const head = normalized.split(/\s+/)[0];
  if (!head) return undefined;
  return KNOWN_PROVIDERS.has(head) ? (head as KnownProvider) : "shell";
}

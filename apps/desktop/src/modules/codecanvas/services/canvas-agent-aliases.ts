const RUNNER_DISPLAY: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
  aider: "Aider",
  opencode: "OpenCode",
  custom: "Custom",
};

const RUNNER_VOICE_ALIASES: Record<string, string[]> = {
  claude: ["Claude", "Claude agent", "Cloud agent"],
  codex: ["Codex", "Codex agent", "Code X", "Kodeks", "Cortex", "OpenAI agent"],
  cursor: ["Cursor", "Cursor agent"],
  gemini: ["Gemini", "Gemini agent"],
  aider: ["Aider", "Aider agent"],
  opencode: ["OpenCode", "OpenCode agent", "Open Code agent"],
};

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const ORDINAL_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function pushUnique(target: string[], value: string) {
  const clean = value.trim();
  if (!clean) return;
  if (target.some((item) => item.toLowerCase() === clean.toLowerCase())) return;
  target.push(clean);
}

export function runnerDisplayLabel(value: unknown): string {
  const runner = cleanString(value).toLowerCase();
  return RUNNER_DISPLAY[runner] ?? cleanString(value);
}

/**
 * Human handles for an Agent node's runner identity. Voice users naturally say “Codex” or
 * “the Claude agent”, while the visible node may be named “Nova”. Keep this conservative:
 * aliases are metadata handles for already-visible agents, not new capabilities.
 */
export function buildAgentRunnerAliases(input: {
  name?: unknown;
  runner?: unknown;
  runnerLabel?: unknown;
  runnerCommand?: unknown;
  runnerOrdinal?: number;
}): string[] {
  const aliases: string[] = [];
  const name = cleanString(input.name);
  const runner = cleanString(input.runner).toLowerCase();
  const runnerLabel = cleanString(input.runnerLabel);

  for (const alias of RUNNER_VOICE_ALIASES[runner] ?? []) pushUnique(aliases, alias);
  if (runnerLabel) {
    pushUnique(aliases, runnerLabel);
    pushUnique(aliases, `${runnerLabel} agent`);
  } else if (runner && !RUNNER_VOICE_ALIASES[runner]) {
    const display = runnerDisplayLabel(runner);
    pushUnique(aliases, display);
    pushUnique(aliases, `${display} agent`);
  }

  const command = cleanString(input.runnerCommand);
  const display = runnerDisplayLabel(runnerLabel || runner);
  if (display && input.runnerOrdinal && input.runnerOrdinal > 0) {
    pushUnique(aliases, `${display} ${input.runnerOrdinal}`);
    pushUnique(aliases, `${display} ${ORDINAL_WORDS[input.runnerOrdinal] ?? input.runnerOrdinal}`);
    pushUnique(aliases, `${display} agent ${input.runnerOrdinal}`);
    pushUnique(aliases, `${display} agent ${ORDINAL_WORDS[input.runnerOrdinal] ?? input.runnerOrdinal}`);
    if (runner === "claude") {
      pushUnique(aliases, `Cloud ${input.runnerOrdinal}`);
      pushUnique(aliases, `Cloud ${ORDINAL_WORDS[input.runnerOrdinal] ?? input.runnerOrdinal}`);
      pushUnique(aliases, `Cloud agent ${input.runnerOrdinal}`);
    }
  }

  if (runner === "custom" && !runnerLabel && command) {
    const firstWord = command.split(/\s+/)[0];
    pushUnique(aliases, firstWord);
    pushUnique(aliases, `${firstWord} agent`);
  }

  return aliases.filter((alias) => alias.toLowerCase() !== name.toLowerCase());
}

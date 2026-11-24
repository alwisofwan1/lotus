import { AGENT_TYPES } from "@/modules/codespace/components/constants";

export interface SavedTerminalCommand {
  id: string;
  name: string;
  command: string;
}

export interface TerminalFleetSettingsShape {
  terminal?: {
    savedCommands?: SavedTerminalCommand[];
  };
}

export interface PresetCustomCommandShape {
  agentSlots?: Record<string, number>;
  customCommands?: Record<string, string>;
  customCommandNames?: Record<string, string>;
}

export interface FleetAgentDefinition {
  id: string;
  name: string;
  command: string;
  description: string;
  isCustom: boolean;
}

const BUILT_IN_AGENT_IDS = new Set(AGENT_TYPES.map((agent) => agent.id));

function toTitleCase(value: string): string {
  return value
    .split(/[\s-_]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

export function deriveSavedTerminalCommandName(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "Custom Command";

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "Custom Command";

  let candidate = tokens[0] ?? "";
  if ((candidate === "bun" || candidate === "pnpm") && tokens[1] === "x") {
    candidate = tokens[2] ?? candidate;
  } else if (candidate === "pnpm" && tokens[1] === "dlx") {
    candidate = tokens[2] ?? candidate;
  } else if (candidate === "npx" || candidate === "bunx" || candidate === "uvx") {
    candidate = tokens[1] ?? candidate;
  } else if ((candidate === "python" || candidate === "python3") && tokens[1] === "-m") {
    candidate = tokens[2] ?? candidate;
  }

  const executable = candidate
    .split(/[\\/]/)
    .filter(Boolean)
    .pop()
    ?.replace(/\.(cmd|exe|bat|sh)$/i, "")
    .trim() ?? "";

  if (!executable) return "Custom Command";
  return toTitleCase(executable);
}

export function ensureUniqueSavedTerminalCommandName(
  proposedName: string,
  commands: SavedTerminalCommand[],
  excludeId?: string,
): string {
  const baseName = proposedName.trim() || "Custom Command";
  const usedNames = new Set(
    commands
      .filter((entry) => entry.id !== excludeId)
      .map((entry) => entry.name.trim().toLowerCase())
      .filter(Boolean),
  );

  if (!usedNames.has(baseName.toLowerCase())) {
    return baseName;
  }

  let suffix = 2;
  while (usedNames.has(`${baseName.toLowerCase()} ${suffix}`)) {
    suffix += 1;
  }
  return `${baseName} ${suffix}`;
}

export function isBuiltInAgentId(id: string): boolean {
  return BUILT_IN_AGENT_IDS.has(id);
}

export function getSavedTerminalCommandsFromSettings(
  settings: TerminalFleetSettingsShape | Record<string, unknown>,
): SavedTerminalCommand[] {
  const rawCommands = getTerminalSection(settings)?.savedCommands;
  if (!Array.isArray(rawCommands)) return [];

  const seen = new Set<string>();
  const commands: SavedTerminalCommand[] = [];

  for (const rawCommand of rawCommands) {
    if (
      !rawCommand ||
      typeof rawCommand !== "object" ||
      typeof rawCommand.id !== "string" ||
      typeof rawCommand.name !== "string" ||
      typeof rawCommand.command !== "string"
    ) {
      continue;
    }

    const id = rawCommand.id.trim();
    const name = rawCommand.name.trim();
    const command = rawCommand.command.trim();
    if (!id || !name || !command || seen.has(id)) continue;

    seen.add(id);
    commands.push({ id, name, command });
  }

  return commands;
}

export function mergeSavedTerminalCommandsIntoSettings(
  settings: TerminalFleetSettingsShape | Record<string, unknown>,
  commands: SavedTerminalCommand[],
): TerminalFleetSettingsShape {
  const current = getTerminalSection(settings) ?? {};
  return {
    ...(settings as TerminalFleetSettingsShape),
    terminal: {
      ...current,
      savedCommands: commands,
    },
  };
}

export function getFleetAgentDefinitions(
  savedCommands: SavedTerminalCommand[],
  preset?: PresetCustomCommandShape,
): FleetAgentDefinition[] {
  const definitions: FleetAgentDefinition[] = AGENT_TYPES.map((agent) => ({
    id: agent.id,
    name: agent.name,
    command: agent.command,
    description: agent.description,
    isCustom: false,
  }));

  const seen = new Set(definitions.map((definition) => definition.id));

  for (const command of savedCommands) {
    if (seen.has(command.id)) continue;
    seen.add(command.id);
    definitions.push({
      id: command.id,
      name: command.name,
      command: command.command,
      description: command.command,
      isCustom: true,
    });
  }

  if (!preset?.customCommands) return definitions;

  for (const [id, command] of Object.entries(preset.customCommands)) {
    const trimmedCommand = command.trim();
    if (!trimmedCommand || seen.has(id) || isBuiltInAgentId(id)) continue;

    seen.add(id);
    definitions.push({
      id,
      name: preset.customCommandNames?.[id]?.trim() || "Custom Command",
      command: trimmedCommand,
      description: trimmedCommand,
      isCustom: true,
    });
  }

  return definitions;
}

export function buildAgentCommands(
  slots: Record<string, number>,
  agentDefinitions: FleetAgentDefinition[],
  total: number,
): string[] {
  const definitionsById = new Map(agentDefinitions.map((definition) => [definition.id, definition]));
  const commands: string[] = [];

  for (const [id, count] of Object.entries(slots)) {
    if (count <= 0) continue;
    const definition = definitionsById.get(id);
    if (!definition || !definition.command.trim()) continue;
    for (let index = 0; index < count; index += 1) {
      commands.push(definition.command);
    }
  }

  while (commands.length < total) commands.push("");
  return commands.slice(0, total);
}

function getTerminalSection(
  settings: TerminalFleetSettingsShape | Record<string, unknown>,
): TerminalFleetSettingsShape["terminal"] {
  if (!settings || typeof settings !== "object") return undefined;
  const terminal = (settings as TerminalFleetSettingsShape).terminal;
  return terminal && typeof terminal === "object" ? terminal : undefined;
}

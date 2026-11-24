import type { CodeChatEffort, CodeChatModelOption } from "@/lib/types";

const KNOWN_MODEL_ALIASES: Record<string, string> = {
  fable: "Fable",
  sonnet: "Sonnet",
  opus: "Opus",
  haiku: "Haiku",
};

const BRAND_TOKENS: Record<string, string> = {
  claude: "Claude",
  gpt: "GPT",
  codex: "Codex",
};

/**
 * Transform a raw model identifier into a human-readable label.
 *
 * Examples:
 *  - "sonnet" → "Sonnet"
 *  - "claude-sonnet-4-6" → "Claude Sonnet 4.6"
 *  - "gpt-5.4-mini" → "GPT 5.4 Mini"
 *  - "gpt-5.3-codex-spark" → "GPT 5.3 Codex Spark"
 */
export function formatModelLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;

  // Direct alias match (e.g. "sonnet" → "Sonnet")
  const alias = KNOWN_MODEL_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;

  // Split on hyphens, then process each segment
  const parts = trimmed.split("-");
  const result: string[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    // Check brand tokens
    const brand = BRAND_TOKENS[part.toLowerCase()];
    if (brand) {
      result.push(brand);
      continue;
    }

    // Check known aliases mid-string (e.g. "sonnet" in "claude-sonnet-4-6")
    const midAlias = KNOWN_MODEL_ALIASES[part.toLowerCase()];
    if (midAlias) {
      result.push(midAlias);
      continue;
    }

    // If this segment is purely numeric and the NEXT segment is also purely numeric,
    // merge them with a dot: "4" + "6" → "4.6"
    if (/^\d+$/.test(part) && i + 1 < parts.length && /^\d+$/.test(parts[i + 1])) {
      result.push(`${part}.${parts[i + 1]}`);
      i++; // skip the next segment — already consumed
      continue;
    }

    // If segment already contains a dot (e.g. "5.4"), keep as-is
    if (/^\d[\d.]*$/.test(part)) {
      result.push(part);
      continue;
    }

    // Capitalize first letter of remaining words
    result.push(part.charAt(0).toUpperCase() + part.slice(1));
  }

  return result.join(" ");
}

export function mergeDiscoveredModelOptions(
  baseOptions: CodeChatModelOption[],
  discoveredValues: string[],
): CodeChatModelOption[] {
  const merged = [...baseOptions];
  const seen = new Set(baseOptions.map((option) => option.value));

  for (const value of discoveredValues) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    merged.push({ label: formatModelLabel(normalized), value: normalized });
  }

  return merged;
}

// `minimal` is gone: Claude ignores it with a warning, so admitting it from a CLI's own report
// would put it back in front of the user as if it worked.
const VALID_EFFORTS = new Set<CodeChatEffort>(["low", "medium", "high", "xhigh", "max"]);

export function mergeDiscoveredEffortOptions(
  baseEfforts: CodeChatEffort[],
  discoveredEfforts: string[],
): CodeChatEffort[] {
  const merged = [...baseEfforts];
  const seen = new Set<string>(baseEfforts);

  for (const effort of discoveredEfforts) {
    const normalized = effort.trim() as CodeChatEffort;
    if (!normalized || seen.has(normalized) || !VALID_EFFORTS.has(normalized)) continue;
    seen.add(normalized);
    merged.push(normalized);
  }

  return merged;
}

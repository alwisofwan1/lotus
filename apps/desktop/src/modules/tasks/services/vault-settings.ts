import type { ClaudeSettings } from "@/modules/settings/types";

/**
 * Where this machine's Obsidian vault is, and what Lotus found when it looked.
 *
 * The path lives in `~/.claude/settings.json` beside every other Settings value, NOT in shell
 * layout preferences: that store is localStorage and says of itself that it holds no paths, and a
 * vault location is a fact about this machine rather than about how a window was arranged.
 */

export type VaultSettings = {
  /** Empty means no vault — the default, and a perfectly good state to be in. */
  path: string;
};

export const DEFAULT_VAULT_SETTINGS: VaultSettings = { path: "" };

/**
 * Read the path, and be unsurprised by anything else the file holds.
 *
 * `~/.claude/settings.json` is edited by people, by older builds and by other tools. A wrong type
 * where a path should be is not an error to throw on boot — it is simply not a vault path.
 */
export function resolveVaultSettings(
  settings: ClaudeSettings | null | undefined,
): VaultSettings {
  const raw = (settings as { vault?: unknown } | null | undefined)?.vault;
  if (!raw || typeof raw !== "object") return { ...DEFAULT_VAULT_SETTINGS };

  const path = (raw as Record<string, unknown>).path;
  if (typeof path !== "string") return { ...DEFAULT_VAULT_SETTINGS };

  // Trimmed, and whitespace collapses to unset: clearing the field leaves spaces behind, and a
  // path of spaces would be probed, fail, and report an error about a vault nobody asked for.
  return { path: path.trim() };
}

/** What looking at the configured path told us. */
export type VaultProbe =
  | { kind: "unset" }
  | { kind: "read"; ticketCount: number }
  /** `reason` is the sentence the reader produced; it already names the path. */
  | { kind: "failed"; reason: string };

export type VaultProbeMessage = {
  tone: "neutral" | "ok" | "warn" | "error";
  message: string;
};

/**
 * The sentence the Settings section shows.
 *
 * A path setting that only stores a string fails silently until somebody opens Tasks and wonders
 * why it is empty. So the section looks, and says what it saw — including when what it saw is
 * fine. Four tones because there are four different things to do about them: nothing, nothing,
 * check the frontmatter, fix the path.
 */
/**
 * Can the Connect button be pressed?
 *
 * Only once the path has actually been read. A vault that reads as empty still counts: it has a
 * `tickets/` directory and tickets arrive later, and refusing it would make the button argue with
 * a path that is already right.
 */
export function canConnectVault(probe: VaultProbe): boolean {
  return probe.kind === "read";
}

export function describeVaultProbe(probe: VaultProbe): VaultProbeMessage {
  if (probe.kind === "unset") {
    // Addressed to somebody who has just opened the field, not to somebody reading app state:
    // they know there is no vault, that is why they are here. Say what to do instead.
    return { tone: "neutral", message: "Pick a folder to check it." };
  }

  if (probe.kind === "failed") {
    // Verbatim. The reader already named the path and what was wrong with it, and rewording it
    // here would be a second vocabulary for one fact — the vaguer of the two.
    return { tone: "error", message: probe.reason };
  }

  if (probe.ticketCount === 0) {
    return {
      tone: "warn",
      message: "No tickets found. Files in tickets/ need a ticket: field in their frontmatter.",
    };
  }

  return {
    tone: "ok",
    message: `${probe.ticketCount} ticket${probe.ticketCount === 1 ? "" : "s"} read.`,
  };
}

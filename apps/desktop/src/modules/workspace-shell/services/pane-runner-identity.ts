import { deriveFleetIdentity, type FleetProvider } from "@/modules/codespace/services/bridge/fleet-naming";
import { findSpec } from "@/modules/codespace/services/bridge/agent-registry";
import type { GridCell } from "@/modules/codespace/components/types";
import type { PaneRunnerIdentity } from "@/modules/workspace-shell/types";

/**
 * Which CLI a pane is running, in the shape its header draws.
 *
 * **This file names nothing.** `deriveFleetIdentity` already answers "which provider, called
 * what", with the precedence that cost a day to get right — runtime reality (`runtimeProvider`,
 * read from the CLI's own banner by `fleet-output-tap`) over birth intent (`agentCommand`), so a
 * shell someone typed `claude` into is a Claude pane and a Claude pane handed to Codex is a Codex
 * one. A second naming table here is how two surfaces come to call one agent different things.
 *
 * All this adds is the MARK: the logo the agent registry gives that provider, if any. A provider
 * without one takes the generic mark rather than borrowing someone else's.
 */

/**
 * The runner behind a pane, or `undefined` when there is no agent to name.
 *
 * `undefined` is the answer for a browser, an editor, a conversation and — deliberately — a plain
 * shell. A shell is a shell: giving it a robot mark would claim an agent that is not there, and
 * the pane header falls back to its kind glyph, which is the truth.
 */
export function paneRunnerIdentity(cell: GridCell): PaneRunnerIdentity | undefined {
  if (cell.type !== "terminal") return undefined;

  const identity = deriveFleetIdentity({
    agentCommand: cell.agentCommand,
    detectedProvider: cell.runtimeProvider,
  });
  if (identity.provider === "shell") return undefined;

  const src = findSpec(identity.provider)?.logo;
  return {
    provider: identity.provider,
    label: identity.providerDisplayName,
    mark: src ? { kind: "logo", src } : { kind: "generic" },
  };
}

// The Chat runners that speak the Agent Client Protocol, read from `src/agents.json` (its `acp`
// field). Shared by the chat bridge (spawn, modes, sign-in) and the UI (tab, name, logo), so a new
// ACP agent is one `acp` block there, after a probe (plans/chat-acp-runners/PLAN.md).
// Relative import: the chat bridge is bundled by `bun build`, outside Next's `@/` alias.
import catalog from "../../../../agents.json";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** Kept literal so `Runner` stays a closed union; a test checks it against agents.json. */
export type AcpRunner = "cursor" | "antigravity";

export interface AcpAgent {
  id: AcpRunner;
  label: string;
  /** The binary on PATH; `LOTUS_<BINARY>_PATH` overrides it. */
  binary: string;
  args: string[];
  /** What the user runs to sign in. */
  signIn: string;
  /** How the account row names the sign-in ("Google login"). */
  authLabel: string;
  /** Lotus's four permission modes as the agent's own `mode` values. */
  modes: Record<PermissionMode, string>;
  /** `_meta` key under which the agent appends a system prompt; none when it takes no such hint. */
  systemPromptMeta?: string;
  notInstalled: string;
  notSignedIn: string;
}

export const ACP_AGENTS: readonly AcpAgent[] = catalog.agents.flatMap((a) =>
  a.acp
    ? [
        {
          id: a.id as AcpRunner,
          label: a.name,
          binary: a.command[0],
          args: a.acp.args,
          signIn: a.acp.signIn,
          authLabel: a.acp.authLabel,
          modes: a.acp.modes,
          systemPromptMeta: a.acp.systemPromptMeta,
          notInstalled: `${a.name} isn’t installed. Install the ${a.productName} CLI (\`${a.command[0]}\`), then send again.`,
          notSignedIn: `${a.name} isn’t signed in. Run \`${a.acp.signIn}\` in a terminal and log in, then send again.`,
        },
      ]
    : [],
);

export const acpAgent = (runner: string): AcpAgent | undefined => ACP_AGENTS.find((a) => a.id === runner);

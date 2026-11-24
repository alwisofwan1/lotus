/**
 * How to install each known agent CLI, for the "Available" rows in Settings › Agents.
 *
 * Checked against each vendor's own install page on 2026-11-19. Ids match `KNOWN_CLIS` in
 * `src-tauri/src/cli_detect.rs`; an id missing here simply gets no Install button.
 * `windows` is the PowerShell variant for the curl | bash installers (checked 2026-11-19: each URL
 * serves a real .ps1); npm and uv commands are the same on every OS.
 */
export interface CliInstall {
  command: string;
  windows?: string;
  docs?: string;
}

/** The install command for this OS. */
export function installCommand(install: CliInstall): string {
  const win = typeof navigator !== "undefined" && /Win/.test(navigator.userAgent);
  return (win && install.windows) || install.command;
}

export const CLI_INSTALL: Record<string, CliInstall> = {
  claude: { command: "curl -fsSL https://claude.ai/install.sh | bash", windows: "irm https://claude.ai/install.ps1 | iex", docs: "https://docs.claude.com/en/docs/claude-code/setup" },
  codex: { command: "npm install -g @openai/codex", docs: "https://developers.openai.com/codex/cli" },
  cursor: { command: "curl https://cursor.com/install -fsS | bash", windows: "irm 'https://cursor.com/install?win32=true' | iex", docs: "https://cursor.com/docs/cli/overview" },
  antigravity: { command: "curl -fsSL https://antigravity.google/cli/install.sh | bash", windows: "irm https://antigravity.google/cli/install.ps1 | iex", docs: "https://antigravity.google/docs/cli/install" },
  gemini: { command: "npm install -g @google/gemini-cli", docs: "https://github.com/google-gemini/gemini-cli" },
  opencode: { command: "npm install -g opencode-ai", docs: "https://opencode.ai/docs" },
  grok: { command: "curl -fsSL https://x.ai/cli/install.sh | bash", windows: "irm https://x.ai/cli/install.ps1 | iex", docs: "https://docs.x.ai/build/overview" },
  droid: { command: "curl -fsSL https://app.factory.ai/cli | sh", windows: "irm https://app.factory.ai/cli/windows | iex", docs: "https://docs.factory.ai/cli/getting-started/quickstart" },
  copilot: { command: "npm install -g @github/copilot", docs: "https://docs.github.com/copilot/how-tos/set-up/install-copilot-cli" },
  kimi: { command: "uv tool install --python 3.13 kimi-cli", docs: "https://moonshotai.github.io/kimi-cli/en/guides/getting-started.html" },
  pi: { command: "npm install -g @earendil-works/pi-coding-agent" },
};

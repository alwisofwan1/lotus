import type { SshTarget } from "@/modules/codespace/services/ssh-command";

export type SshConfigHost = {
  alias: string;
  hostname?: string | null;
  user?: string | null;
  port?: number | null;
};

export type SshTargetOption = SshTarget & {
  id: string;
  label: string;
  source: "config" | "manual";
  alias?: string;
  hostname?: string;
  capability: "shell" | "git";
  disabledReason?: string;
};

export type ManualSshTargetInput = {
  host: string;
  user?: string;
  port?: string;
  label?: string;
};

const HOST_PATTERN = /^[A-Za-z0-9._-]+$/;
const USER_PATTERN = /^[A-Za-z0-9._-]+$/;
const KNOWN_GIT_SSH_HOSTS = new Set([
  "bitbucket.org",
  "github.com",
  "gitlab.com",
  "ssh.github.com",
]);

export function getSshTargetCapability(target: {
  alias?: string;
  hostname?: string;
  host: string;
  user?: string;
}): Pick<SshTargetOption, "capability" | "disabledReason"> {
  const user = target.user?.toLowerCase();
  const hostname = target.hostname?.toLowerCase();
  const aliasOrHost = (target.alias || target.host).toLowerCase();
  const looksLikeGitProvider = Boolean(hostname && KNOWN_GIT_SSH_HOSTS.has(hostname))
    || /(^|[-_.])(github|gitlab|bitbucket)([-_.]|$)/.test(aliasOrHost);

  if (user === "git" && looksLikeGitProvider) {
    return {
      capability: "git",
      disabledReason: "This SSH alias is for Git authentication and does not provide an interactive shell.",
    };
  }

  return { capability: "shell" };
}

export function normalizeSshConfigHosts(hosts: SshConfigHost[]): SshTargetOption[] {
  const seen = new Set<string>();
  const options: SshTargetOption[] = [];

  for (const host of hosts) {
    const alias = host.alias.trim();
    if (!alias || alias.includes("*") || seen.has(alias)) continue;
    seen.add(alias);
    const user = host.user?.trim() || undefined;
    const hostname = host.hostname?.trim() || undefined;
    const port = host.port ?? undefined;
    const capability = getSshTargetCapability({
      alias,
      host: alias,
      hostname,
      user,
    });
    options.push({
      id: `config:${alias}`,
      label: alias,
      source: "config",
      alias,
      host: alias,
      hostname,
      user,
      port,
      ...capability,
    });
  }

  return options;
}

export function parseManualSshTarget(input: ManualSshTargetInput): SshTargetOption {
  const host = input.host.trim();
  const user = input.user?.trim() || undefined;
  const label = input.label?.trim();
  const portText = input.port?.trim();
  const parsedPort = portText ? Number(portText) : null;

  if (!HOST_PATTERN.test(host)) {
    throw new Error("Use a config alias or hostname without spaces.");
  }
  if (user && !USER_PATTERN.test(user)) {
    throw new Error("SSH user contains unsupported characters.");
  }
  if (parsedPort !== null && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)) {
    throw new Error("SSH port must be between 1 and 65535.");
  }
  const port = parsedPort ?? undefined;

  return {
    id: `manual:${user ? `${user}@` : ""}${host}${port ? `:${port}` : ""}`,
    label: label || host,
    source: "manual",
    host,
    user,
    port,
    capability: "shell",
  };
}

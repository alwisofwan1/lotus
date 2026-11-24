import {
  getSshTargetCapability,
  normalizeSshConfigHosts,
  parseManualSshTarget,
  type SshConfigHost,
  type SshTargetOption,
} from "@/modules/codespace/services/ssh-targets";
import type { CodeCanvasProjectMeta } from "@/lib/tauri/codecanvas";
import { machineFromLocation, machineKey, sshTarget } from "./machine";

/**
 * What the Add-project list offers, as one list rather than a sequence of questions.
 *
 * The mockup (`plans/codecanvas-vps-connector/design/vps-connector.html`, screens 01–03) merges what
 * were three steps — pick a kind, pick a machine, or type one — into a single page, because the
 * second time an operator adds a project on a machine they already use, three taps for a decision
 * they have already made is the cost that got a `+` button rejected in Pocket on 2026-08-11.
 */
export type AddProjectLocalChoice = { kind: "local"; id: string; label: string; detail: string };

export type AddProjectMachineChoice = {
  kind: "machine";
  id: string;
  label: string;
  detail: string;
  target: { host: string; user?: string; port?: number };
  /** How many projects are already open on this machine — 0 when it is new to us. */
  projectCount: number;
  /** Set when the row cannot be used, with the reason an operator can act on. */
  disabledReason?: string;
  /**
   * The Cloudflare Access application behind this machine, when it has one.
   *
   * Only `~/.ssh/config` knows this, so a machine remembered from a project alone will not carry it.
   * That is honest rather than unfortunate: we would be guessing, and a wrong "needs sign-in" label
   * sends an operator to a browser they did not need to open.
   */
  accessHostname?: string;
};

export type AddProjectChoice = AddProjectLocalChoice | AddProjectMachineChoice;

/** `~/.ssh/config` entries, plus the Access application Rust read off each `ProxyCommand`. */
export type AddProjectHost = SshConfigHost & { accessHostname?: string | null };

export interface AddProjectInput {
  hosts: readonly AddProjectHost[];
  /** Existing canvas projects — used to count and to surface machines not in ~/.ssh/config. */
  projects: readonly CodeCanvasProjectMeta[];
  /** Whatever the operator has typed into the one field, if anything. */
  query?: string;
}

function projectMachineKey(project: CodeCanvasProjectMeta): string | null {
  return machineKey(machineFromLocation(project.location)) || null;
}

/**
 * Machines an operator has actually used, even when `~/.ssh/config` never mentioned them.
 *
 * A host typed by hand once must come back as a row the next time — otherwise "remembered" is a
 * promise the empty state makes (screen 11) and nothing keeps.
 */
function machinesFromProjects(projects: readonly CodeCanvasProjectMeta[]): SshTargetOption[] {
  const seen = new Map<string, SshTargetOption>();
  for (const project of projects) {
    const location = project.location;
    if (!location || location.kind !== "ssh") continue;
    const option = parseManualSshTarget({
      host: location.host,
      user: location.user ?? undefined,
      port: location.port ? String(location.port) : undefined,
      label: location.label ?? undefined,
    });
    seen.set(machineKey(sshTarget(option)), option);
  }
  return [...seen.values()];
}

/**
 * Every row the Add-project list shows, in the order it shows them.
 *
 * A git-only alias (`git@github.com`, in nearly every `~/.ssh/config`) is deliberately still listed,
 * disabled, with its reason: hiding it sends an operator hunting for an alias they know exists, and
 * offering it produces a failure that looks like our bug rather than SSH's design.
 */
export function addProjectChoices(input: AddProjectInput): AddProjectChoice[] {
  const counts = new Map<string, number>();
  for (const project of input.projects) {
    const key = projectMachineKey(project);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // The alias is the only thing `normalizeSshConfigHosts` carries through, so the Access name is
  // re-attached by it rather than threaded through CodeSpace's shared target type.
  const accessByAlias = new Map<string, string>();
  for (const host of input.hosts) {
    const alias = host.alias?.trim();
    const access = host.accessHostname?.trim();
    if (alias && access) accessByAlias.set(alias, access);
  }

  const fromConfig = normalizeSshConfigHosts([...input.hosts]);
  const known = machinesFromProjects(input.projects);
  const byKey = new Map<string, SshTargetOption>();
  for (const option of [...known, ...fromConfig]) {
    const key = machineKey(sshTarget(option));
    if (!byKey.has(key)) byKey.set(key, option);
  }

  const machines: AddProjectMachineChoice[] = [...byKey.entries()]
    .map(([key, option]) => {
      const capability = getSshTargetCapability({
        alias: option.alias,
        hostname: option.hostname,
        host: option.host,
        user: option.user ?? undefined,
      });
      const target = sshTarget(option);
      const detail = `${target.user ? `${target.user}@` : ""}${target.host}${target.port ? `:${target.port}` : ""}`;
      const access = option.alias ? accessByAlias.get(option.alias) : undefined;
      return {
        kind: "machine" as const,
        id: key,
        label: option.label,
        detail,
        target,
        projectCount: counts.get(key) ?? 0,
        ...(capability.disabledReason ? { disabledReason: capability.disabledReason } : {}),
        ...(access ? { accessHostname: access } : {}),
      };
    })
    .sort((a, b) => {
      if (!!a.disabledReason !== !!b.disabledReason) return a.disabledReason ? 1 : -1;
      if (a.projectCount !== b.projectCount) return b.projectCount - a.projectCount;
      return a.label.localeCompare(b.label);
    });

  const rows: AddProjectChoice[] = [
    { kind: "local", id: "local", label: "Local folder…", detail: "Pick a directory on this Mac" },
    ...machines,
  ];

  const query = input.query?.trim().toLowerCase();
  if (!query) return rows;
  return rows.filter(
    (row) => row.label.toLowerCase().includes(query) || row.detail.toLowerCase().includes(query),
  );
}

/**
 * The machine an operator typed, when the field holds one this list does not already offer.
 *
 * Returns null for anything that is not a plausible target (a path, an empty field, a host with
 * spaces) so the caller can simply not offer the row rather than raise an error at someone who is
 * still typing.
 */
export function machineFromQuery(
  query: string,
  existing: readonly AddProjectChoice[] = [],
): AddProjectMachineChoice | null {
  const raw = query.trim();
  if (!raw || raw.startsWith("/") || raw.startsWith("~") || /\s/.test(raw)) return null;

  const atSign = raw.lastIndexOf("@");
  const user = atSign > 0 ? raw.slice(0, atSign) : undefined;
  const hostPart = atSign > 0 ? raw.slice(atSign + 1) : raw;
  const colon = hostPart.lastIndexOf(":");
  const host = colon > 0 ? hostPart.slice(0, colon) : hostPart;
  const port = colon > 0 ? hostPart.slice(colon + 1) : undefined;
  if (!host) return null;

  let option: SshTargetOption;
  try {
    option = parseManualSshTarget({ host, user, port });
  } catch {
    return null;
  }

  const target = sshTarget(option);
  const key = machineKey(target);
  if (existing.some((row) => row.id === key)) return null;

  return {
    kind: "machine",
    id: key,
    label: option.label,
    detail: `${target.user ? `${target.user}@` : ""}${target.host}${target.port ? `:${target.port}` : ""}`,
    target,
    projectCount: 0,
  };
}

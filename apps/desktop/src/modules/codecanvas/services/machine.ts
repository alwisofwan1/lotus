import type { CodeCanvasProjectLocation } from "@/lib/tauri/codecanvas";

/**
 * The other machine a canvas project lives on. A project on this machine has none — `null`.
 *
 * The one canvas-side shape for it: the store row (`CodeCanvasProjectLocation`) spells "no user" as
 * `null`, while `SshTarget`, `buildSshCommand` and the PTY controller spell it as an absent key.
 * {@link machineFromLocation} converts once at the boundary, and the two target helpers below are
 * the only places that pick a spelling for a Tauri call.
 */
export interface Machine {
  kind: "ssh";
  host: string;
  user?: string;
  port?: number;
  label?: string;
}

/** What a key or a target is made of — tolerant of the `null`s the store and `SshTargetOption` carry. */
type MachineIdentity = { host: string; user?: string | null; port?: number | null };

/** The store row's location as a `Machine`, or null for this machine or a row with no host. */
export function machineFromLocation(location: CodeCanvasProjectLocation | null | undefined): Machine | null {
  if (!location || location.kind !== "ssh" || !location.host?.trim()) return null;
  return {
    kind: "ssh",
    host: location.host.trim(),
    ...(location.user ? { user: location.user } : {}),
    ...(location.port ? { port: location.port } : {}),
    ...(location.label ? { label: location.label } : {}),
  };
}

/**
 * The same identity the Rust store keys a project by, so counts line up with rows; `""` for this
 * machine.
 *
 * Also what effects depend on instead of the object, which is rebuilt on every render. The label is
 * left out on purpose: renaming a machine is not reconnecting to it.
 */
export function machineKey(machine: Machine | MachineIdentity | null | undefined): string {
  if (!machine) return "";
  const host = machine.host.trim().toLowerCase();
  const user = machine.user?.trim().toLowerCase();
  return `ssh:${user ? `${user}@` : ""}${host}${machine.port ? `:${machine.port}` : ""}`;
}

/** The machine as an `SshTarget`: absent keys, no label. */
export function sshTarget(machine: Machine | MachineIdentity): { host: string; user?: string; port?: number } {
  return {
    host: machine.host,
    ...(machine.user ? { user: machine.user } : {}),
    ...(machine.port ? { port: machine.port } : {}),
  };
}

/** The machine as Rust's `SshToolTarget` expects it: absent spelled `null`, because serde round-trips it. */
export function wireTarget(machine: Machine | MachineIdentity): { host: string; user: string | null; port: number | null } {
  return { host: machine.host, user: machine.user ?? null, port: machine.port ?? null };
}

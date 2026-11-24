import { tauriInvoke } from "@/lib/tauri/runtime";

/** An SSH machine, as `cli_tools::SshToolTarget`. */
export interface HostTarget {
  host: string;
  user?: string;
  port?: number;
}

/** `managed_host::ManagedHostStatus`: what the machine says about its Lotus host. */
export interface ManagedHostStatus {
  os: string;
  /** `x64` or `arm64`; null on a machine Lotus has no host for. */
  arch: string | null;
  kind: "none" | "managed" | "manual";
  version: string | null;
  running: boolean;
}

export type ManagedHostStep = "download" | "check" | "install" | "start" | "health" | "restore" | "remove";

export function managedHostStatus(target: HostTarget): Promise<ManagedHostStatus> {
  return tauriInvoke<ManagedHostStatus>("managed_host_status", { target });
}

/** One step over SSH. `version` is the app version: the release to fetch and the build health must see. */
export function managedHostStep(target: HostTarget, step: ManagedHostStep, version: string): Promise<void> {
  return tauriInvoke<void>("managed_host_step", { target, step, version });
}

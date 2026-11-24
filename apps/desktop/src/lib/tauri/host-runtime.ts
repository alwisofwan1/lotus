import { isTauri, tauriInvoke } from "@/lib/tauri/runtime";

/**
 * Launch state of the embedded host runtime.
 *
 * Field names are snake_case on purpose: Rust tags the variant with
 * `rename_all = "snake_case"`, which renames variants but **not** the fields
 * inside them. Pinned by `status_json_shape_is_pinned_for_the_frontend`.
 */
export type HostRuntimeStatus =
  | { kind: "idle" }
  | { kind: "running"; pid: number }
  | { kind: "crashed"; code: number | null; last_lifetime_ms: number }
  | { kind: "misconfigured"; reasons: string[] };

/**
 * Whether this machine is being held awake for a phone to reach it.
 *
 * `unsupported` is not an error: only macOS has an implementation, and a Windows or
 * Linux desktop simply sleeps as it always did. Pinned by
 * `sleep_hold_json_shape_is_pinned_for_the_frontend`.
 */
export type SleepHoldState =
  | { kind: "holding" }
  | { kind: "released" }
  | { kind: "unsupported" }
  | { kind: "failed"; reason: string };

/** Who can reach an address, as classified by `host_runtime::interfaces`. */
export type Reach = "loopback" | "tailnet" | "lan" | "public";

export interface BindCandidate {
  interface: string;
  address: string;
  reach: Reach;
  recommended: boolean;
}

export interface MobileDevice {
  deviceId: string;
  name: string;
  pairedAt: number;
  expiresAt: number;
  hardExpiresAt: number;
}

export interface PairingCode {
  code: string;
  expiresAt: number;
}

export interface MobileReachability {
  /** Whether the façade has a listening socket at all. */
  bound: boolean;
  /** Bound to something a phone can actually route to. Loopback is not. */
  reachableByPhone: boolean;
  address: { host: string; port: number } | null;
  deviceCount: number;
}

/** Why an admin call failed. `not-running` is a normal state, not a fault. */
export type AdminFailureReason = "not-running" | "unknown";

export class AdminCallError extends Error {
  constructor(
    readonly reason: AdminFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "AdminCallError";
  }
}

/** Matches `AdminError::NotAdvertised`'s message from `admin_client.rs`. */
const NOT_ADVERTISED = "has not advertised an admin channel";

function toAdminError(err: unknown): AdminCallError {
  const message = typeof err === "string" ? err : ((err as Error)?.message ?? String(err));
  return new AdminCallError(
    message.includes(NOT_ADVERTISED) ? "not-running" : "unknown",
    message,
  );
}

/**
 * On-disk host runtime config.
 *
 * snake_case because Rust declares no `rename_all` here, unlike the tagged
 * `HostRuntimeStatus` beside it. Pinned by `config_json_shape_is_pinned_for_the_frontend`.
 */
export interface HostRuntimeConfig {
  enabled: boolean;
  default_provider: string | null;
  bind_address: string | null;
}

/** Port the host binds when nothing says otherwise (`core/config.ts` fallback). */
export const DEFAULT_MOBILE_PORT = 8787;

const DISABLED: HostRuntimeConfig = {
  enabled: false,
  default_provider: null,
  bind_address: null,
};

export async function getHostRuntimeConfig(): Promise<HostRuntimeConfig> {
  if (!isTauri()) return { ...DISABLED };
  return tauriInvoke<HostRuntimeConfig>("host_runtime_get_config");
}

/** Persists only. The supervisor does not reconcile until `applyHostRuntime`. */
export async function saveHostRuntimeConfig(config: HostRuntimeConfig): Promise<void> {
  if (!isTauri()) throw new AdminCallError("not-running", "Not running inside Lotus");
  await tauriInvoke("host_runtime_save_config", { config });
}

/**
 * Reconciles the runtime with the saved config and returns where it landed.
 *
 * A rejected bind address comes back as `{ kind: "misconfigured", reasons }`
 * rather than a thrown error, so callers must read the result, not just await it.
 */
export async function applyHostRuntime(): Promise<HostRuntimeStatus> {
  if (!isTauri()) throw new AdminCallError("not-running", "Not running inside Lotus");
  return tauriInvoke<HostRuntimeStatus>("host_runtime_apply");
}

/**
 * Turns a bind candidate's bare address into the `host:port` the config demands.
 *
 * IPv6 is bracketed first: its own colons would otherwise make "does this already
 * have a port?" unanswerable, and Rust's `split_host_port` would reject the result.
 */
export function bindAddressFor(address: string, port = DEFAULT_MOBILE_PORT): string {
  const trimmed = address.trim();
  if (trimmed.startsWith("[")) return trimmed.includes("]:") ? trimmed : `${trimmed}:${port}`;
  const colons = (trimmed.match(/:/g) ?? []).length;
  if (colons > 1) return `[${trimmed}]:${port}`;
  return colons === 1 ? trimmed : `${trimmed}:${port}`;
}

export async function getHostRuntimeStatus(): Promise<HostRuntimeStatus> {
  if (!isTauri()) return { kind: "idle" };
  return tauriInvoke<HostRuntimeStatus>("host_runtime_status");
}

/** Outside Tauri nothing is holding anything, and saying `released` is the truth. */
export async function getSleepHold(): Promise<SleepHoldState> {
  if (!isTauri()) return { kind: "released" };
  return tauriInvoke<SleepHoldState>("host_runtime_sleep_hold");
}

export async function listBindCandidates(): Promise<BindCandidate[]> {
  if (!isTauri()) return [];
  return tauriInvoke<BindCandidate[]>("host_runtime_bind_candidates");
}

export async function createPairingCode(): Promise<PairingCode> {
  if (!isTauri()) throw new AdminCallError("not-running", "Not running inside Lotus");
  try {
    return await tauriInvoke<PairingCode>("host_runtime_create_pairing_code");
  } catch (err) {
    throw toAdminError(err);
  }
}

/** Empty when the host is off, because the section already says it is off. */
export async function listMobileDevices(): Promise<MobileDevice[]> {
  if (!isTauri()) return [];
  try {
    const res = await tauriInvoke<{ items: MobileDevice[] }>("host_runtime_list_devices");
    return res.items;
  } catch (err) {
    const mapped = toAdminError(err);
    if (mapped.reason === "not-running") return [];
    throw mapped;
  }
}

export async function revokeMobileDevice(deviceId: string): Promise<void> {
  if (!isTauri()) throw new AdminCallError("not-running", "Not running inside Lotus");
  try {
    await tauriInvoke("host_runtime_revoke_device", { deviceId });
  } catch (err) {
    throw toAdminError(err);
  }
}

const UNREACHABLE_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Whether a phone could actually reach the façade right now.
 *
 * Never raises: a host that is off is the normal starting state, and the
 * settings section renders the answer rather than an error.
 */
export async function getMobileReachability(): Promise<MobileReachability> {
  const off: MobileReachability = {
    bound: false,
    reachableByPhone: false,
    address: null,
    deviceCount: 0,
  };
  if (!isTauri()) return off;

  try {
    const health = await tauriInvoke<{
      mobile: { host: string; port: number } | null;
      deviceCount?: number;
    }>("host_runtime_admin_health");

    const address = health.mobile;
    return {
      bound: address !== null,
      reachableByPhone: address !== null && !UNREACHABLE_HOSTS.has(address.host),
      address,
      deviceCount: health.deviceCount ?? 0,
    };
  } catch {
    return off;
  }
}

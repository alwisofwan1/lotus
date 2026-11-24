export const TERMINAL_V2_NATIVE_RUNTIME_STORAGE_KEY = "lotus:terminal-v2-native-runtime";

export type TerminalV2NativeRuntimeRolloutMode = "opt-in" | "default-on-non-production" | "default-on-all-environments";

export type TerminalV2NativeRuntimePolicy =
  | { kind: "bridge"; reason: "default-off" | "local-storage-disabled" | "production-disabled" | "storage-unavailable" }
  | { kind: "native"; reason: "local-storage-opt-in" | "rollout-default-on-non-production" | "rollout-default-on-all-environments" };

export type TerminalV2NativeRuntimePolicyInput = {
  env?: string;
  rolloutMode?: TerminalV2NativeRuntimeRolloutMode;
  storage?: Pick<Storage, "getItem"> | null;
};

function readNativeRuntimePreference(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(TERMINAL_V2_NATIVE_RUNTIME_STORAGE_KEY);
  } catch {
    return "storage-unavailable";
  }
}

export function resolveTerminalV2NativeRuntimePolicy({
  env = process.env.NODE_ENV,
  rolloutMode = "opt-in",
  storage = typeof window === "undefined" ? null : window.localStorage,
}: TerminalV2NativeRuntimePolicyInput = {}): TerminalV2NativeRuntimePolicy {
  const preference = readNativeRuntimePreference(storage);
  if (preference === "0") return { kind: "bridge", reason: "local-storage-disabled" };
  if (preference === "storage-unavailable") return { kind: "bridge", reason: "storage-unavailable" };
  if (rolloutMode === "default-on-all-environments") {
    return { kind: "native", reason: "rollout-default-on-all-environments" };
  }
  if (env === "production") return { kind: "bridge", reason: "production-disabled" };

  if (preference === "1") return { kind: "native", reason: "local-storage-opt-in" };
  if (rolloutMode === "default-on-non-production") {
    return { kind: "native", reason: "rollout-default-on-non-production" };
  }
  return { kind: "bridge", reason: "default-off" };
}

import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_V2_NATIVE_RUNTIME_STORAGE_KEY,
  resolveTerminalV2NativeRuntimePolicy,
} from "../terminal-v2-native-runtime-policy";

describe("resolveTerminalV2NativeRuntimePolicy", () => {
  it("uses the legacy bridge runtime by default", () => {
    expect(resolveTerminalV2NativeRuntimePolicy({ env: "development", storage: null })).toEqual({
      kind: "bridge",
      reason: "default-off",
    });
  });

  it("enables native runtime only when explicitly opted in", () => {
    const storage = { getItem: vi.fn((key: string) => key === TERMINAL_V2_NATIVE_RUNTIME_STORAGE_KEY ? "1" : null) };

    expect(resolveTerminalV2NativeRuntimePolicy({ env: "development", storage })).toEqual({
      kind: "native",
      reason: "local-storage-opt-in",
    });
  });

  it("keeps bridge runtime when explicitly disabled", () => {
    const storage = { getItem: vi.fn(() => "0") };

    expect(resolveTerminalV2NativeRuntimePolicy({ env: "development", storage })).toEqual({
      kind: "bridge",
      reason: "local-storage-disabled",
    });
  });

  it("never enables native runtime in production", () => {
    const storage = { getItem: vi.fn(() => "1") };

    expect(resolveTerminalV2NativeRuntimePolicy({ env: "production", storage })).toEqual({
      kind: "bridge",
      reason: "production-disabled",
    });
  });

  it("can default native runtime on outside production through an explicit rollout mode", () => {
    expect(resolveTerminalV2NativeRuntimePolicy({
      env: "development",
      rolloutMode: "default-on-non-production",
      storage: null,
    })).toEqual({
      kind: "native",
      reason: "rollout-default-on-non-production",
    });
  });

  it("keeps localStorage disable as an emergency override during rollout", () => {
    const storage = { getItem: vi.fn(() => "0") };

    expect(resolveTerminalV2NativeRuntimePolicy({
      env: "development",
      rolloutMode: "default-on-non-production",
      storage,
    })).toEqual({
      kind: "bridge",
      reason: "local-storage-disabled",
    });
  });

  it("does not default native runtime on in production during non-production rollout", () => {
    expect(resolveTerminalV2NativeRuntimePolicy({
      env: "production",
      rolloutMode: "default-on-non-production",
      storage: null,
    })).toEqual({
      kind: "bridge",
      reason: "production-disabled",
    });
  });

  it("can default native runtime on in production through the approved all-environments rollout mode", () => {
    expect(resolveTerminalV2NativeRuntimePolicy({
      env: "production",
      rolloutMode: "default-on-all-environments",
      storage: null,
    })).toEqual({
      kind: "native",
      reason: "rollout-default-on-all-environments",
    });
  });

  it("keeps localStorage disable as an emergency override during all-environments rollout", () => {
    const storage = { getItem: vi.fn(() => "0") };

    expect(resolveTerminalV2NativeRuntimePolicy({
      env: "production",
      rolloutMode: "default-on-all-environments",
      storage,
    })).toEqual({
      kind: "bridge",
      reason: "local-storage-disabled",
    });
  });
});

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  AdminCallError,
  applyHostRuntime,
  bindAddressFor,
  createPairingCode,
  getHostRuntimeConfig,
  getHostRuntimeStatus,
  getMobileReachability,
  getSleepHold,
  listBindCandidates,
  listMobileDevices,
  revokeMobileDevice,
  saveHostRuntimeConfig,
  type AdminFailureReason,
  type BindCandidate,
  type HostRuntimeConfig,
  type HostRuntimeStatus,
  type MobileDevice,
  type MobileReachability,
  type SleepHoldState,
} from "@/lib/tauri/host-runtime";

/**
 * The three states the section headline can be in.
 *
 * `local-only` is the one worth naming: the host is up, everything reports
 * healthy, and no phone can reach it. Collapsing it into "running" is how that
 * failure stays invisible.
 */
export type ReachState = "not-running" | "local-only" | "reachable";

export interface ActivePairing {
  code: string;
  expiresAt: number;
  secondsLeft: number;
}

const DISABLED_CONFIG: HostRuntimeConfig = {
  enabled: false,
  default_provider: null,
  bind_address: null,
};

const NO_HEALTH: MobileReachability = {
  bound: false,
  reachableByPhone: false,
  address: null,
  deviceCount: 0,
};

function deriveReach(health: MobileReachability): ReachState {
  if (!health.bound) return "not-running";
  return health.reachableByPhone ? "reachable" : "local-only";
}

export function useMobileAccess() {
  const [status, setStatus] = useState<HostRuntimeStatus>({ kind: "idle" });
  const [candidates, setCandidates] = useState<BindCandidate[]>([]);
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [health, setHealth] = useState<MobileReachability>(NO_HEALTH);
  const [sleepHold, setSleepHold] = useState<SleepHoldState>({ kind: "released" });
  const [pairing, setPairing] = useState<ActivePairing | null>(null);
  const [pairingError, setPairingError] = useState<AdminFailureReason | null>(null);
  /// The backend's own words for an `unknown` failure. A category alone hid a dead
  /// port behind "could not reach" for three weeks (2026-10-04).
  const [pairingErrorDetail, setPairingErrorDetail] = useState<string | null>(null);
  const [config, setConfig] = useState<HostRuntimeConfig>(DISABLED_CONFIG);
  /// Reasons a bind address was refused. Empty is the healthy state.
  const [configErrors, setConfigErrors] = useState<string[]>([]);
  const [armedDeviceId, setArmedDeviceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Read the clock here, not in render: a component that calls `Date.now()`
  // while rendering is impure, so "expired" would depend on when React happened
  // to re-render rather than on the clock.
  const [now, setNow] = useState(() => Date.now());

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const [nextStatus, nextConfig, nextCandidates, nextDevices, nextHealth, nextSleepHold] =
      await Promise.all([
        getHostRuntimeStatus(),
        getHostRuntimeConfig(),
        listBindCandidates(),
        listMobileDevices().catch(() => [] as MobileDevice[]),
        getMobileReachability(),
        getSleepHold(),
      ]);
    if (!alive.current) return;
    setStatus(nextStatus);
    setConfig(nextConfig);
    setCandidates(nextCandidates);
    setDevices(nextDevices);
    setHealth(nextHealth);
    setSleepHold(nextSleepHold);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A code that sits on screen past its expiry invites the operator to type
  // something the host will reject, so it is removed rather than frozen at zero.
  useEffect(() => {
    if (pairing === null) return;
    const tick = () => {
      const secondsLeft = Math.ceil((pairing.expiresAt - Date.now()) / 1000);
      if (secondsLeft <= 0) {
        setPairing(null);
        return;
      }
      setPairing((current) => (current === null ? null : { ...current, secondsLeft }));
    };
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  // A device session lasts 12 hours, so a 30s tick is plenty to flip the label
  // without waking the app up for nothing.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  /**
   * Writes the config and reconciles the runtime, in that order.
   *
   * Both, always: saving alone changes nothing the operator can see, because the
   * supervisor only reconciles on apply. And apply answers with `misconfigured`
   * instead of throwing, so the result has to be READ, not merely awaited.
   */
  const writeConfig = useCallback(
    async (patch: Partial<HostRuntimeConfig>) => {
      setBusy(true);
      try {
        const next = { ...config, ...patch };
        setConfig(next);
        await saveHostRuntimeConfig(next);
        const resolved = await applyHostRuntime();
        if (!alive.current) return;
        setConfigErrors(resolved.kind === "misconfigured" ? resolved.reasons : []);
      } catch (err) {
        if (!alive.current) return;
        setConfigErrors([err instanceof Error ? err.message : String(err)]);
      } finally {
        if (alive.current) setBusy(false);
      }
      await refresh();
    },
    [config, refresh],
  );

  const setEnabled = useCallback(
    (enabled: boolean) => writeConfig({ enabled }),
    [writeConfig],
  );

  /// Choosing an address also turns the runtime on: picking the tailnet and then
  /// hunting for a separate switch is two steps for one intent.
  const selectBindAddress = useCallback(
    (address: string) => writeConfig({ enabled: true, bind_address: bindAddressFor(address) }),
    [writeConfig],
  );

  const requestPairingCode = useCallback(async () => {
    setBusy(true);
    setPairingError(null);
    setPairingErrorDetail(null);
    try {
      const { code, expiresAt } = await createPairingCode();
      if (!alive.current) return;
      setPairing({
        code,
        expiresAt,
        secondsLeft: Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
      });
      // A fresh code means the host is up; the headline may be stale.
      void refresh();
    } catch (err) {
      if (!alive.current) return;
      setPairingError(err instanceof AdminCallError ? err.reason : "unknown");
      setPairingErrorDetail(err instanceof Error ? err.message : String(err));
      // A failed call is the likeliest moment the runtime has died; re-read so the
      // section can say so instead of leaving a stale headline beside the error.
      void refresh();
    } finally {
      if (alive.current) setBusy(false);
    }
  }, [refresh]);

  const revoke = useCallback(
    async (deviceId: string) => {
      setBusy(true);
      try {
        await revokeMobileDevice(deviceId);
      } finally {
        if (alive.current) {
          setArmedDeviceId(null);
          setBusy(false);
        }
      }
      // Re-read rather than splicing locally: the host owns the store, and a
      // local splice would hide a revoke that did not actually land.
      await refresh();
    },
    [refresh],
  );

  return {
    status,
    candidates,
    devices,
    health,
    sleepHold,
    reach: deriveReach(health),
    config,
    configErrors,
    setEnabled,
    selectBindAddress,
    now,
    pairing,
    pairingError,
    pairingErrorDetail,
    armedDeviceId,
    busy,
    armRevoke: setArmedDeviceId,
    requestPairingCode,
    revoke,
    refresh,
  };
}

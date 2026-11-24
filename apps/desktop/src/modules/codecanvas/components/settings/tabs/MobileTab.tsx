"use client";
import { QRCodeSVG } from "qrcode.react";

import { buildPairingInvite } from "@/lib/pairing-invite";
import type {
  BindCandidate,
  HostRuntimeStatus,
  MobileDevice,
  Reach,
  SleepHoldState,
} from "@/lib/tauri/host-runtime";
import { useMobileAccess, type ReachState } from "@/modules/codecanvas/hooks/useMobileAccess";
import { SettingsSection as Section } from "@/modules/lotus-settings/components/SettingsSection";
import { SettingToggleRow } from "@/modules/lotus-settings/components/SettingToggleRow";
import { SettingRow } from "@/modules/lotus-settings/components/SettingsGroup";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/ui/status";

/**
 * Reachability leads, everything else follows.
 *
 * The costly failure here is not a host that is down; it is a host that is UP and
 * bound to loopback, where every indicator reads healthy and no phone can route to
 * it. So the section says which of the three it is, in words, before offering
 * anything to press.
 */
const REACH_COPY: Record<ReachState, { title: string; desc: string }> = {
  "not-running": {
    title: "Not running",
    desc: "Lotus Pocket reaches this machine through the host runtime. Nothing is listening yet.",
  },
  "local-only": {
    title: "Running, but only this machine can reach it",
    desc: "Bound to loopback. A phone cannot route to it, so pairing will fail even though everything here looks healthy.",
  },
  reachable: {
    title: "Reachable",
    desc: "A paired phone on the same network can reach this machine.",
  },
};

const REACH_TAG: Record<Reach, string> = {
  loopback: "this machine only",
  tailnet: "your devices, over the tailnet",
  lan: "anything on this network",
  public: "routable from the internet",
};

/**
 * Mobile Access sits in the *Lotus* group of Lotus Settings: pairing is per machine, and Pocket
 * dispatches to any pane, correlating by `LOTUS_PANE_ID` — not only to canvas cells.
 */
export function MobileTab() {
  const {
    status,
    candidates,
    devices,
    health,
    reach,
    sleepHold,
    pairing,
    pairingError,
    pairingErrorDetail,
    armedDeviceId,
    busy,
    now,
    config,
    configErrors,
    armRevoke,
    requestPairingCode,
    revoke,
    setEnabled,
    selectBindAddress,
  } = useMobileAccess();

  const copy = REACH_COPY[reach];

  return (
    <div className="flex flex-col gap-6">
      <Section label="Mobile access" description="Pair Lotus Pocket with this machine.">
        {/* The switch is the first control: nothing else on this tab can do
            anything while the runtime is off. */}
        <SettingToggleRow
          title="Enable mobile access"
          description={
            <>
              <span data-reach={reach} className="font-medium text-(--ui-ink)">
                {copy.title}
              </span>
              {" — "}
              {copy.desc}
            </>
          }
          checked={config.enabled}
          onChange={(next) => void setEnabled(next)}
          disabled={busy}
        />

        {health.address !== null && (
          <SettingRow label="Listening on" monoDescription description={`${health.address.host}:${health.address.port}`} />
        )}

        {config.enabled && status.kind === "crashed" && <CrashedRow status={status} />}

        <SleepHoldRow state={sleepHold} />


        {configErrors.length > 0 && (
          <SettingRow
            label={<span className="text-(--ui-err)">The runtime refused to start</span>}
            body={
              <ul className="m-0 list-disc pl-4 ds-t-meta leading-relaxed text-(--ui-ink-3)">
                {configErrors.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            }
          />
        )}
      </Section>

      {config.enabled && (
        <Section
          label="Pairing"
          description="A code is single-use and expires in five minutes."
        >
          <SettingRow label="Pair a phone" description="Type the code into Lotus Pocket on your phone.">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void requestPairingCode()}>
              Pair a phone
            </Button>
          </SettingRow>

          {pairingError === "not-running" && (
            <SettingRow label="The runtime is not answering" description="Turn it off and on again above." />
          )}
          {pairingError === "unknown" && (
            <SettingRow
              label="Could not reach the host runtime"
              description="On its local control channel."
              body={
                pairingErrorDetail !== null ? (
                  <p className="m-0 break-all font-mono ds-t-meta text-(--ui-ink-3)" data-testid="pairing-error-detail">
                    {pairingErrorDetail}
                  </p>
                ) : undefined
              }
            />
          )}

          {pairing !== null && (
            <div className="p-3.5">
              {health.address !== null && health.reachableByPhone && (
                <PairingQr
                  host={health.address.host}
                  port={health.address.port}
                  code={pairing.code}
                />
              )}
              {/* Grouped in fours, because eight digits get typed on a phone keypad —
                  still the path when the camera is refused, and the only path for a
                  Standalone Host, which has no screen to show a QR on. */}
              <p className="m-0 font-mono ds-t-display tracking-[0.22em] text-(--ui-ink)">
                {pairing.code.slice(0, 4)} {pairing.code.slice(4)}
              </p>
              <p
                className="m-0 mt-1 ds-t-meta leading-relaxed text-(--ui-ink-3)"
                data-testid="pairing-countdown"
              >
                {/* A line of text, not a spinner: the number is the information. */}
                Expires in {formatCountdown(pairing.secondsLeft)}
                {reach === "local-only" && (
                  <strong className="text-(--ui-ink)">
                    {" "}
                    This code will not help yet: nothing outside this machine can reach the runtime.
                  </strong>
                )}
              </p>
            </div>
          )}
        </Section>
      )}

      <BindPicker
        candidates={candidates}
        selected={config.bind_address}
        busy={busy}
        onSelect={(address) => void selectBindAddress(address)}
      />

      <DeviceList
        devices={devices}
        armedDeviceId={armedDeviceId}
        busy={busy}
        now={now}
        onArm={armRevoke}
        onRevoke={(id) => void revoke(id)}
      />
    </div>
  );
}

/** SIGKILL in the shell's `128 + signal` form, which is how Rust reports a signal death. */
const KILLED_EXIT = 137;

/**
 * The runtime was started and is gone.
 *
 * Without this row a crash read exactly like "never started": the headline says
 * "Not running" either way. The exit code is the one clue that tells them apart,
 * and 137 on launch has a specific cause worth naming — macOS refusing an
 * executable whose code signature does not match (2026-10-04).
 */
function CrashedRow({ status }: { status: Extract<HostRuntimeStatus, { kind: "crashed" }> }) {
  const killedOnLaunch = status.code === KILLED_EXIT && status.last_lifetime_ms < 5_000;
  return (
    <div className="ui-row" data-testid="runtime-crashed">
      <div className="ui-row-text">
      <span className="ui-row-label text-(--ui-err)">
        {killedOnLaunch ? "macOS stopped the runtime as it launched" : "The runtime stopped"}
      </span>
      <span className="ui-row-desc">
        {killedOnLaunch
          ? "It was killed before it could run (exit 137). The usual cause is an invalid code signature on the host executable — update or reinstall Lotus."
          : `Exited${status.code === null ? "" : ` with code ${status.code}`} after ${formatLifetime(status.last_lifetime_ms)}.`}{" "}
        Turn mobile access off and on again to retry.
      </span>
      </div>
    </div>
  );
}

function formatLifetime(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/**
 * The pairing code as something a phone can read off the screen.
 *
 * Three decisions here are correctness rather than styling:
 *
 * * **Black on white, always, whatever the app's theme is.** Scanners expect dark
 *   modules on a light field; an inverted QR is decoded by some readers and not by
 *   others, and "it works on my phone" is the worst way to find that out. So this is
 *   the one surface in a dark UI that is deliberately a white card.
 * * **It carries the BOUND address, never a candidate.** Whatever the operator picked
 *   in "Listen on" is what answers, and a QR that published anything else would send
 *   the phone somewhere nothing is listening.
 * * **It is not rendered at all when nothing outside this machine can route to the
 *   bound address** (the caller's `reachableByPhone` guard). On loopback the payload
 *   would be `127.0.0.1`, and a phone dialling its own loopback fails in a way that
 *   looks like a broken app rather than a wrong bind. The typed digits and the
 *   existing warning stay, so nothing is taken away.
 */
function PairingQr({ host, port, code }: { host: string; port: number; code: string }) {
  return (
    <div className="mb-3 flex justify-start">
      <div className="rounded-lg bg-white p-3" data-testid="pairing-qr">
        <QRCodeSVG
          value={buildPairingInvite({ host, port, code })}
          size={168}
          bgColor="#ffffff"
          fgColor="#000000"
          // Medium recovery, not the default low: this is read off a glossy monitor at
          // an angle, and the payload is short enough that the extra modules cost
          // nothing in scanning distance.
          level="M"
          title="Lotus pairing code"
        />
      </div>
    </div>
  );
}

/**
 * A picker, not a text field: `0.0.0.0` and typos never become choices.
 *
 * Every row is labelled by WHO can reach it rather than by interface name, because
 * `utun4` answers a question nobody asked.
 */
function BindPicker({
  candidates,
  selected,
  busy,
  onSelect,
}: {
  candidates: BindCandidate[];
  /** Saved `host:port`, or null while the host is on its localhost default. */
  selected: string | null;
  busy: boolean;
  onSelect: (address: string) => void;
}) {
  if (candidates.length === 0) return null;
  const hasTailnet = candidates.some((c) => c.reach === "tailnet");

  return (
    <Section label="Listen on" description="Which address the host binds. 0.0.0.0 is never offered.">
      {candidates.map((candidate) => {
        // Compared on the host half: the saved value carries a port the candidate
        // list does not.
        const isSelected = selected !== null && hostOf(selected) === candidate.address;
        return (
          <SettingRow
            key={`${candidate.interface}-${candidate.address}`}
            label={
              <span className="inline-flex items-center gap-2">
                <span className="font-mono">{candidate.address}</span>
                {candidate.recommended && <Tag accent>recommended</Tag>}
              </span>
            }
            description={`${REACH_TAG[candidate.reach]} · ${candidate.interface}`}
          >
            <Button
              variant={isSelected ? "primary" : "secondary"}
              size="sm"
              role="radio"
              aria-checked={isSelected}
              aria-label={`Listen on ${candidate.address}`}
              disabled={busy}
              onClick={() => onSelect(candidate.address)}
            >
              {isSelected ? "In use" : "Use this"}
            </Button>
          </SettingRow>
        );
      })}
      {!hasTailnet && (
        <SettingRow label="No tailnet interface found" description="Without one, the only reachable option is your local network." />
      )}
    </Section>
  );
}

function DeviceList({
  devices,
  armedDeviceId,
  busy,
  now,
  onArm,
  onRevoke,
}: {
  devices: MobileDevice[];
  armedDeviceId: string | null;
  busy: boolean;
  /** Supplied by the hook so render stays pure. */
  now: number;
  onArm: (deviceId: string | null) => void;
  onRevoke: (deviceId: string) => void;
}) {
  return (
    <Section label="Paired devices" description="A token expires in 12 hours and cannot be renewed past 30 days.">
      {devices.length === 0 && (
        <SettingRow label="No devices paired yet" />
      )}

      {devices.map((device) => {
        const armed = armedDeviceId === device.deviceId;
        const expired = device.expiresAt <= now;
        return (
          <SettingRow
            key={device.deviceId}
            label={
              <span className="inline-flex items-center gap-2">
                {device.name}
                {/* Expired is not revoked: the pairing still exists and a refresh from the phone brings it back. */}
                {expired && <Tag>needs refresh</Tag>}
              </span>
            }
            monoDescription
            // Both expiries, always: one is renewable and one is not.
            description={`session ${formatWhen(device.expiresAt)} · hard limit ${formatWhen(device.hardExpiresAt)}`}
          >
            {armed ? (
              // Armed inline rather than in a dialog: the row you are about to act
              // on stays visible, and the confirm button NAMES the device so a
              // second click cannot land on the wrong one.
              <>
                <Button variant="danger" size="sm" disabled={busy} onClick={() => onRevoke(device.deviceId)}>
                  Revoke {device.name}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => onArm(null)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => onArm(device.deviceId)}>
                Revoke
              </Button>
            )}
          </SettingRow>
        );
      })}
    </Section>
  );
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function formatWhen(timestamp: number): string {
  if (timestamp <= 0) return "unknown";
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Says whether this machine will still be awake to answer the phone.
 *
 * The lid sentence is not a caveat bolted on, it is the point. The hold is
 * `PreventUserIdleSystemSleep`, which keeps an open, untouched laptop up and does
 * nothing about a closed one — and an operator who shuts the lid believing otherwise
 * finds out from a phone that has gone quiet, at which point it reads as a broken app.
 *
 * Silent while released: before mobile access is on there is nothing to explain, and a
 * row saying "not holding" would be noise on the one screen that must stay scannable.
 */
function SleepHoldRow({ state }: { state: SleepHoldState }) {
  if (state.kind === "released") return null;

  const [title, detail] =
    state.kind === "holding"
      ? ["This machine will not fall asleep", "Closing the lid still sleeps it."]
      : state.kind === "unsupported"
        ? [
            "This machine can still fall asleep",
            "Holding sleep off is implemented on macOS only.",
          ]
        : ["Could not stop this machine sleeping", state.reason];

  return (
    <SettingRow label={title} description={detail} />
  );
}

/** Host half of a `host:port`, bracketed IPv6 included. */
function hostOf(bindAddress: string): string {
  const trimmed = bindAddress.trim();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    return close === -1 ? trimmed : trimmed.slice(1, close);
  }
  const colon = trimmed.lastIndexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

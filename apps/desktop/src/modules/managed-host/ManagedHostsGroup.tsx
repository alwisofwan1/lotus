"use client";
import { ArrowRight, Server } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { IconTile, Status } from "@/components/ui/status";
import { SettingRow, SettingsGroup } from "@/modules/lotus-settings/components/SettingsGroup";
import { HostSteps } from "./ManagedHostBanner";
import {
  compareVersions,
  installHost,
  loadManagedHosts,
  managedHostEnabled,
  manualUpdateCommand,
  offerFor,
  probeHost,
  removeHost,
  useManagedHosts,
  type HostEntry,
} from "./managed-host";

function describe(entry: HostEntry, appVersion: string | null): string {
  const s = entry.status;
  if (entry.step === "remove") return "Removing…";
  if (!s) return entry.probing ? "Checking…" : "Not reachable right now";
  if (!s.arch) return `${s.os || "This system"} · no host for this system`;
  if (s.kind === "none") return `No host · Linux ${s.arch}`;
  const v = s.version ?? "unknown version";
  if (s.kind === "manual") return `${v} · installed by hand · update with install.sh`;
  if (entry.failure) return `${v} · the last update failed`;
  if (appVersion && s.version && compareVersions(s.version, appVersion) > 0) return `${v} · host is newer, update Lotus`;
  if (appVersion && s.version && compareVersions(s.version, appVersion) < 0) return `${v} → ${appVersion}`;
  return `${v} · up to date · ~/.lotus/host`;
}

function HostRow({ entry, appVersion }: { entry: HostEntry; appVersion: string | null }) {
  const { target, status, step } = entry;
  useEffect(() => {
    void probeHost(target);
  }, [target]);
  const offer = offerFor(status, appVersion);
  const busy = Boolean(step);
  return (
    <SettingRow
      leading={<IconTile><Server size={15} /></IconTile>}
      label={target.host}
      monoDescription
      description={
        busy && step !== "remove" ? <HostSteps entry={entry} /> : (
          <span className="inline-flex flex-wrap items-center gap-1.5 tabular-nums" aria-live="polite">
            {offer === "update" && status?.version ? (
              <>
                <span>{status.version}</span>
                <ArrowRight size={11} aria-label="to" />
                <span className="text-(--ui-ink)">{appVersion}</span>
              </>
            ) : (
              <span>{describe(entry, appVersion)}</span>
            )}
          </span>
        )
      }
    >
      {busy ? <Status busy>{step === "remove" ? "Removing" : "Working"}</Status> : null}
      {!busy && offer ? (
        <Button size="sm" onClick={() => void installHost(target)}>
          {entry.failure ? "Try again" : offer === "install" ? "Install" : "Update"}
        </Button>
      ) : null}
      {!busy && entry.failure ? (
        <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(entry.failure ?? "")}>Copy log</Button>
      ) : null}
      {!busy && status?.kind === "manual" && appVersion ? (
        <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(manualUpdateCommand(status, appVersion))}>
          Copy command
        </Button>
      ) : null}
      {!busy && status?.kind === "managed" ? (
        <Button size="sm" variant="danger" onClick={() => void removeHost(target)}>Remove</Button>
      ) : null}
    </SettingRow>
  );
}

/** Settings › About: one row per SSH machine Lotus has seen, with its host's version and actions. */
export function ManagedHostsGroup() {
  const { appVersion, hosts } = useManagedHosts();
  const enabled = managedHostEnabled();
  useEffect(() => {
    if (enabled) void loadManagedHosts();
  }, [enabled]);
  const entries = Object.values(hosts);
  if (!enabled || entries.length === 0) return null;
  return (
    <SettingsGroup title="Hosts" footer="SSH machines you opened a workspace on. Phone pairing is separate.">
      {entries.map((entry) => (
        <HostRow key={`${entry.target.user ?? ""}@${entry.target.host}:${entry.target.port ?? ""}`} entry={entry} appVersion={appVersion} />
      ))}
    </SettingsGroup>
  );
}

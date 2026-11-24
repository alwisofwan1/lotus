"use client";
import { X } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import type { WorkspaceLocation } from "@/modules/codespace/components/types";
import "@/styles/managed-host.css";
import {
  clearFailure,
  dontAskAgain,
  hostKey,
  installHost,
  INSTALL_STEPS,
  managedHostEnabled,
  notNow,
  offerFor,
  probeHost,
  STEP_LABELS,
  useManagedHosts,
  type HostEntry,
  type HostTarget,
} from "./managed-host";

/** The step list of an install or update: done, running, failed, still to come. */
export function HostSteps({ entry }: { entry: HostEntry }) {
  const failedAt = entry.failure ? INSTALL_STEPS.find((s) => !entry.done.includes(s)) : undefined;
  return (
    <span className="mh-steps">
      {INSTALL_STEPS.map((s) => (
        <span key={s} data-state={entry.done.includes(s) ? "done" : entry.step === s ? "now" : failedAt === s ? "fail" : undefined}>
          {STEP_LABELS[s]}
        </span>
      ))}
    </span>
  );
}

/** A thin line above an SSH workspace: offer to install or update its Lotus host, or say how it went. */
export function ManagedHostBanner({ location }: { location: WorkspaceLocation | null | undefined }) {
  const { appVersion, hosts } = useManagedHosts();
  const ssh = location?.kind === "ssh" ? location : null;
  const host = ssh?.host ?? null;
  const user = ssh?.user;
  const port = ssh?.port;
  const target: HostTarget | null = host ? { host, user, port } : null;
  const key = target ? hostKey(target) : null;

  useEffect(() => {
    if (host) void probeHost({ host, user, port });
  }, [host, user, port]);

  const entry = key ? hosts[key] : undefined;
  if (!target || !entry || !managedHostEnabled()) return null;
  const name = target.host;

  if (entry.step && entry.step !== "remove") {
    return (
      <div className="mh-banner" role="status">
        <span className="mh-text"><b>{entry.status?.kind === "managed" ? "Updating" : "Installing"} host {appVersion}</b></span>
        <HostSteps entry={entry} />
      </div>
    );
  }
  if (entry.failure) {
    return (
      <div className="mh-banner" role="alert">
        <span className="mh-text" title={entry.failure}>
          <span className="mh-err">{entry.status?.kind === "managed" ? "Update failed." : "Install failed."}</span>{" "}
          {entry.status?.kind === "managed" && entry.status.version ? `Host ${entry.status.version} is back and running.` : "Nothing was left on the machine."}
        </span>
        <HostSteps entry={entry} />
        <Button size="sm" onClick={() => void navigator.clipboard?.writeText(entry.failure ?? "")}>Copy log</Button>
        <Button size="sm" variant="ghost" icon aria-label="Close" onClick={() => clearFailure(target)}><X size={13} /></Button>
      </div>
    );
  }

  const offer = offerFor(entry.status, appVersion);
  if (!offer || entry.notNow || (offer === "install" && entry.dontAsk)) return null;
  return (
    <div className="mh-banner">
      {offer === "install" ? (
        <span className="mh-text">
          Install the Lotus host on <b>{name}</b>? It keeps sessions running when Lotus is closed and links them to your phone.
        </span>
      ) : (
        <span className="mh-text">
          Host on <b>{name}</b> is {entry.status?.version}. Sessions stay open during the update.
        </span>
      )}
      <Button size="sm" variant="primary" onClick={() => void installHost(target)}>
        {offer === "install" ? "Install" : `Update to ${appVersion}`}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => notNow(target)}>Not now</Button>
      {offer === "install" ? <Button size="sm" variant="ghost" onClick={() => dontAskAgain(target)}>Don&apos;t ask again</Button> : null}
    </div>
  );
}

"use client";
import { ArrowRight, Check, ChevronRight, Copy, Download, ExternalLink, FolderSearch, RotateCcw, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconTile, Status } from "@/components/ui/status";
import { useEffect, useRef, useState } from "react";
import { RunnerSettingsRows, useRunnerSettings } from "@/modules/codecanvas/components/settings/tabs/RunnersTab";
import { openExternalLink, setCliPath } from "@/lib/tauri-api";
import { CliLogo } from "../components/CliLogo";
import { CLI_INSTALL, installCommand } from "../services/cli-install";
import { SettingRow, SettingsGroup } from "../components/SettingsGroup";
import {
  checkCliUpdates,
  checkCliUpdatesIfStale,
  isActionable,
  runAllCliUpdates,
  runCliUpdate,
  useCliUpdates,
  type CliRunResult,
  type CliUpdateStatus,
} from "../services/cli-updates";

function ago(at: number | null): string {
  if (at === null) return "not checked yet";
  const min = Math.round((Date.now() - at) / 60_000);
  return min < 1 ? "checked just now" : min < 60 ? `checked ${min} min ago` : `checked ${Math.round(min / 60)} h ago`;
}

/** Settings › Agents › CLIs: detected runners merged with their update status, one row each. */
export function AgentClisSection() {
  const { items, checking, checkedAt, error, running, logs, results } = useCliUpdates();
  const cfg = useRunnerSettings();
  // Opening Settings is a moment the user wants fresh numbers; a minute-old answer is fresh enough.
  useEffect(() => checkCliUpdatesIfStale(60_000), []);
  // Coming back from a terminal install should show the new CLI without a click on Rescan.
  const refresh = useRef(cfg.refresh);
  refresh.current = cfg.refresh;
  useEffect(() => {
    const onFocus = () => {
      void refresh.current();
      checkCliUpdatesIfStale(60_000);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const actionable = (items ?? []).filter(isActionable);
  const installed = cfg.runners.filter((r) => r.installed);
  const missing = cfg.runners.filter((r) => !r.installed);
  const row = (r: (typeof cfg.runners)[number]) => {
    const item = items?.find((i) => i.id === r.id);
    const updateId = r.id;
    return (
      <CliRow
        key={r.id}
        runner={r}
        updateId={updateId}
        onChanged={() => void Promise.all([cfg.refresh(), checkCliUpdates()])}
        item={item}
        running={running}
        log={logs[updateId]}
        result={results[updateId]}
        settings={<RunnerSettingsRows r={r} cfg={cfg} />}
      />
    );
  };
  const failed = Object.values(results).filter((r) => !r.ok).length;
  const summary = running
    ? `Updating ${items?.find((i) => i.id === running)?.name ?? running}`
    : failed > 0
      ? `${failed} failed`
      : `${actionable.length === 0 ? "All up to date" : `${actionable.length} update${actionable.length === 1 ? "" : "s"}`} · ${ago(checkedAt)}`;

  return (
    <div className="flex flex-col gap-2">
      <SettingsGroup
        title="CLIs"
        meta={items === null ? (checking ? "Checking versions…" : "Not checked yet") : summary}
        action={
          <>
            {actionable.length > 1 ? (
              <Button variant="primary" size="sm" onClick={() => void runAllCliUpdates()} disabled={running !== null}>
                <Download size={13} />
                Update all
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              icon
              onClick={() => void Promise.all([cfg.refresh(), checkCliUpdates()])}
              disabled={checking || running !== null}
              aria-label="Check again"
              title="Rescan CLIs and check for updates"
            >
              <RotateCcw size={14} className={checking ? "animate-spin" : undefined} />
            </Button>
          </>
        }
        description={
          error || cfg.error || (cfg.loading && !cfg.registry) ? (
            <>
              {error ? <span className="block text-(--ui-err)">Could not check versions: {error}</span> : null}
              {cfg.error ? <span className="block text-(--ui-err)">Failed to load runners: {cfg.error.message}</span> : null}
              {cfg.loading && !cfg.registry ? <span className="block">Detecting installed CLIs…</span> : null}
            </>
          ) : undefined
        }
        as="ul"
      >
        {cfg.registry && installed.length === 0 ? (
          <li className="py-6 text-center">
            <Terminal className="mx-auto mb-2 h-5 w-5 text-(--ui-ink-3)" aria-hidden="true" />
            <p className="m-0 ds-t-body text-(--ui-ink)">No CLIs detected</p>
            <p className="m-0 mt-1 ds-t-meta text-(--ui-ink-3)">Install an agent CLI such as Claude Code, Codex or Antigravity. Lotus finds it when you come back.</p>
          </li>
        ) : null}
        {installed.map(row)}
      </SettingsGroup>

      {missing.length > 0 ? (
        <details className="ui-disclosure">
          <summary>
            <ChevronRight size={12} aria-hidden />
            {missing.length} more you can add
          </summary>
          <ul className="ui-group-card">
            {missing.map((r) => (
              <AvailableRow key={r.id} runner={r} onLocated={() => void Promise.all([cfg.refresh(), checkCliUpdates()])} />
            ))}
          </ul>
        </details>
      ) : null}

    </div>
  );
}

function CliRow({
  runner,
  updateId,
  onChanged,
  item,
  running,
  log,
  result,
  settings,
}: {
  runner: { id: string; name: string; installed: boolean; located?: boolean; path: string | null };
  updateId: string;
  onChanged: () => void;
  item?: CliUpdateStatus;
  running: string | null;
  log?: string[];
  result?: CliRunResult;
  settings: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const busy = running === updateId;
  const behind = !!item && item.latest !== null && item.current !== item.latest && item.state !== "up-to-date";
  const showLog = busy || (result && !result.ok && (log?.length ?? 0) > 0);

  const version = runner.installed ? (
    <span className="inline-flex flex-wrap items-center gap-1.5 tabular-nums">
      <span>{item?.current ?? "unknown version"}</span>
      {behind ? (
        <>
          <ArrowRight size={11} aria-label="to" />
          <span className="text-(--ui-ink)">{item.latest}</span>
        </>
      ) : null}
    </span>
  ) : (
    "Not installed"
  );
  const manual = item?.state === "update-manually" && item.command ? item.command : null;

  return (
    <SettingRow
      as="li"
      muted={!runner.installed}
      leading={
        <IconTile>
          <CliLogo id={runner.id} size={15} brand />
        </IconTile>
      }
      label={runner.name}
      description={version}
      monoDescription={runner.installed}
      body={
        manual || showLog || (open && runner.installed) ? (
          <div className="flex flex-col gap-2">
            {manual ? (
              <div className="ui-codewell">
                <code>{manual}</code>
                <Button variant="ghost" size="sm" icon aria-label="Copy command" title="Copy command" onClick={() => void navigator.clipboard?.writeText(manual)}>
                  <Copy size={13} />
                </Button>
              </div>
            ) : null}
            {showLog ? (
              <pre
                className={`m-0 max-h-28 overflow-auto rounded-(--ui-r-md) px-3 py-2.5 font-mono ds-t-micro leading-relaxed whitespace-pre-wrap text-(--ui-ink-3) ${result && !result.ok ? "bg-[color-mix(in_oklab,var(--ui-err)_9%,transparent)]" : "bg-(--ui-fill)"}`}
              >
                {(log ?? []).join("\n") || "Starting…"}
                {result?.message ? `\n${result.message}` : ""}
              </pre>
            ) : null}
            {open && runner.installed && item?.state === "latest-unknown" && item.canRun ? (
              // The CLI's own updater is a no-op when current; the result is verified by re-reading the version.
              <div className="flex items-center gap-2 ds-t-meta text-(--ui-ink-3)">
                <span className="flex-1">Lotus cannot see the latest version. {item.updater}: <code className="font-mono">{item.command}</code></span>
                <Button size="sm" disabled={running !== null} onClick={() => void runCliUpdate(updateId)}>
                  <RotateCcw size={13} />
                  Run updater
                </Button>
              </div>
            ) : null}
            {open && runner.located ? (
              <div className="flex items-center gap-2 ds-t-meta text-(--ui-ink-3)">
                <span className="flex-1 truncate">
                  You located this at <code className="font-mono">{runner.path}</code>
                </span>
                <Button size="sm" onClick={() => void setCliPath(runner.id, null).then(onChanged)}>
                  Forget
                </Button>
              </div>
            ) : null}
            {open && runner.installed ? settings : null}
          </div>
        ) : undefined
      }
    >
      {runner.installed ? (
        <>
          <RowEnd id={updateId} item={item} busy={busy} result={result} disabled={running !== null} />
          <Button
            variant="ghost"
            size="sm"
            icon
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} settings for ${runner.name}`}
            onClick={() => setOpen((v) => !v)}
          >
            <ChevronRight size={14} className="ui-chevron" style={open ? { transform: "rotate(90deg)" } : undefined} />
          </Button>
        </>
      ) : null}
    </SettingRow>
  );
}

function RowEnd({ id, item, busy, result, disabled }: { id: string; item?: CliUpdateStatus; busy: boolean; result?: CliRunResult; disabled: boolean }) {
  if (busy) return <Status busy>Updating</Status>;
  if (result && !result.ok) {
    return (
      <>
        <Status tone="err">Failed</Status>
        <Button size="sm" disabled={disabled} onClick={() => void runCliUpdate(id)}>
          <RotateCcw size={13} />
          Retry
        </Button>
      </>
    );
  }
  if (result?.ok && item?.state !== "update-available") return <Status tone="ok">Updated</Status>;
  if (item?.state === "update-manually") return <Status>Update in terminal</Status>;
  if (item && isActionable(item)) {
    return (
      <Button variant="primary" size="sm" disabled={disabled} onClick={() => void runCliUpdate(id)}>
        Update
      </Button>
    );
  }
  if (!item) return null;
  // Lotus cannot read the latest version, so a re-check would say the same.
  // Its updater is offered inside the open row (CliRow), so the closed row stays quiet.
  if (item.state === "latest-unknown") return null;
  return <Status tone="ok">Up to date</Status>;
}

/** A known CLI that is not on this Mac: copy its install command, read its docs, or point Lotus at it. */
function AvailableRow({ runner, onLocated }: { runner: { id: string; name: string }; onLocated: () => void }) {
  const install = CLI_INSTALL[runner.id];
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const copy = async () => {
    if (!install) return;
    await navigator.clipboard?.writeText(installCommand(install));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const locate = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ multiple: false, directory: false, title: `Locate ${runner.name}` });
    if (typeof picked !== "string") return;
    try {
      await setCliPath(runner.id, picked);
      setError(null);
      onLocated();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <SettingRow
      as="li"
      leading={
        <IconTile>
          <CliLogo id={runner.id} size={15} brand />
        </IconTile>
      }
      label={runner.name}
      description={
        error ? (
          <span className="text-(--ui-err)">{error}</span>
        ) : copied ? (
          "Copied. Paste it in a terminal; Lotus finds it when you come back."
        ) : (
          (install && installCommand(install)) ?? "Not installed"
        )
      }
      monoDescription={!error && !copied && !!install}
    >
      {install ? (
        <Button size="sm" onClick={() => void copy()} aria-label={`Copy the ${runner.name} install command`}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Install"}
        </Button>
      ) : null}
      {install?.docs ? (
        <Button
          variant="ghost"
          size="sm"
          icon
          aria-label={`${runner.name} docs`}
          title="Docs"
          onClick={() => void openExternalLink(install.docs!)}
        >
          <ExternalLink size={13} />
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        icon
        aria-label={`Locate ${runner.name} on this Mac`}
        title="Already installed? Locate it"
        onClick={() => void locate()}
      >
        <FolderSearch size={13} />
      </Button>
    </SettingRow>
  );
}

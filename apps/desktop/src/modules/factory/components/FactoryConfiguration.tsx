"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { FactoryDefinitionView } from "@/lib/tauri/graph-run";
import type { FactoryAgentsSource } from "../services/factory-agents";
import { FactoryTryChecks } from "./FactoryTryChecks";
import "@/styles/factory-settings.css";

type Suggestion = Awaited<ReturnType<FactoryAgentsSource["suggestChecks"]>>[number];
const recoveryKey = (repo: string) => `lotus:factory-recovery:${repo}`;
function readRecovery(repo: string): string | null {
  try { return window.localStorage.getItem(recoveryKey(repo)); } catch { return null; }
}

/** Configuration lifecycle and separately confirmed check trials, independent of role capabilities. */
export function FactoryConfiguration({ source, checkout, repo, view, onChanged }: {
  source: FactoryAgentsSource;
  checkout: string;
  repo: string;
  view: FactoryDefinitionView;
  onChanged: () => void;
}) {
  const definition = view.local.definition;
  const privateFactory = Boolean(view.private);
  const setup = !definition && privateFactory && view.local.error?.startsWith("no .lotus/factory.toml");
  const [gate, setGate] = useState(definition?.gate ?? "");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [discovery, setDiscovery] = useState("Scanning repository for checks…");
  const [scanGeneration, setScanGeneration] = useState(0);
  const [scanning, setScanning] = useState(false);
  const editedGate = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [recovery, setRecoveryState] = useState<string | null>(() => readRecovery(repo));
  const setRecovery = (id: string | null) => {
    setRecoveryState(id);
    try {
      if (id) window.localStorage.setItem(recoveryKey(repo), id);
      else window.localStorage.removeItem(recoveryKey(repo));
    } catch { /* Recovery remains available in this open view if storage is blocked. */ }
  };
  const group = useId();
  const help = useId();

  useEffect(() => { editedGate.current = false; setGate(definition?.gate ?? ""); }, [definition?.gate]);
  useEffect(() => {
    if (!privateFactory) return;
    let obsolete = false;
    setScanning(true);
    setDiscovery("Scanning repository for checks…");
    void source.suggestChecks(checkout).then((items) => {
      if (obsolete) return;
      setSuggestions(items);
      if (items.length && !editedGate.current) setGate((current) => current.trim() ? current : items[0].command);
      setDiscovery(items.length ? `Found ${items.length} check option${items.length === 1 ? "" : "s"}. Review the source and scope before saving. No commands have been run.` : "No supported checks found. Factory scans check scripts, package.json, Composer/Laravel, Makefile, Cargo.toml and apps/packages modules. Add a project check or enter a custom command.");
    }).catch(() => {
      if (!obsolete) setDiscovery("Could not scan repository checks. Existing choices and your command are preserved; retry the scan or enter a custom command.");
    }).finally(() => { if (!obsolete) setScanning(false); });
    return () => { obsolete = true; };
  }, [source, checkout, privateFactory, scanGeneration]);

  const operate = async (action: () => Promise<unknown>, message: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try { await action(); setNotice(message); onChanged(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const broken = !definition && privateFactory && !setup;
  if (!definition && !setup && !broken) return null;
  const valid = gate.trim().length > 0 && gate.length <= 4096 && !Array.from(gate).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
  return (
    <section className="fa-configuration" aria-label="Factory configuration" aria-busy={busy}>
      <header className="fa-config-heading">
        <div>
          <h2>{setup ? `Set up Factory for ${repo.split("/").at(-1)}` : broken ? "Factory configuration needs repair" : "Factory settings"}</h2>
          <p>{setup ? "Turn tickets into checked changes and draft pull requests." : "Checks and configuration for this repository."}</p>
        </div>
        <span className="fa-config-status">{setup ? "Not configured" : broken ? "Needs repair" : "Configured"}</span>
      </header>
      <p className="fa-config-scope">{privateFactory ? "Configuration stays local to this Mac. Saving does not change repository files." : `Repository configuration. Runs use origin/${view.base ?? "<base>"}; commit and push changes to that branch to activate them.`}</p>
      {notice ? <p role="status" className="fa-config-feedback">{notice}</p> : null}
      {recovery && setup ? (
        <p className="fa-config-feedback">Local configuration is kept in recovery storage. <button type="button" className="rs-button" disabled={busy} onClick={() => void operate(async () => {
          await source.restorePrivate(repo, recovery); setRecovery(null);
        }, "Local Factory configuration restored.")}>Undo removal</button></p>
      ) : null}
      {broken ? <p className="fa-config-feedback">Local configuration could not be read. Repair it, or remove it to start again. Invalid configuration stays archived, but Undo requires a valid definition.</p> : <form onSubmit={(event) => {
        event.preventDefault();
        if (!valid || busy) return;
        void operate(async () => {
          if (setup) { await source.setupPrivate(repo, gate.trim()); setRecovery(null); }
          else await source.saveGate(checkout, repo, gate.trim(), privateFactory);
        }, setup ? "Local Factory created. Saving does not run checks." : "Checks saved. Saving does not run them.");
      }}>
        <h3>Checks before opening a draft PR</h3>
        <p id={help} className="fa-config-description">{privateFactory
          ? "Enter a command that finishes successfully, such as tests or type checking. Factory runs it in each run’s separate worktree after code changes. Avoid development servers and watch mode."
          : "Enter a repository script path, not a shell command (for example tools/gates.sh). Factory runs the script in the run’s worktree."}</p>
        {privateFactory ? (
          <>
            <button type="button" className="rs-button" disabled={busy || scanning} onClick={() => setScanGeneration((n) => n + 1)}>{scanning ? "Scanning repository…" : "Scan repository"}</button>
            <p className="fa-config-discovery" role="status">{discovery}</p>
            {suggestions.length > 0 ? <fieldset className="fa-check-options" disabled={busy}>
              <legend>Detected checks</legend>
              {suggestions.map((item, index) => <label key={item.command} className="fa-check-option">
                <input type="radio" name={group} checked={gate === item.command} onChange={() => { editedGate.current = true; setGate(item.command); }} />
                <span><strong>{item.label} {index === 0 ? <small>Recommended</small> : null}</strong><code>{item.command}</code><small>{item.evidence}</small></span>
              </label>)}
              <label className="fa-check-option"><input type="radio" name={group} checked={!suggestions.some((s) => s.command === gate)} onChange={() => { editedGate.current = true; setGate(""); }} /><span><strong>Custom command</strong><small>Use your project’s own verification command.</small></span></label>
            </fieldset> : null}
          </>
        ) : null}
        <label className="fa-field">
          <span>{privateFactory ? "Command" : "Script path"}</span>
          <input aria-label={privateFactory ? "Gate command" : "Gate script path"} aria-describedby={help} value={gate} disabled={busy} spellCheck={false} maxLength={4096} placeholder={privateFactory ? "e.g. npm run test" : "tools/gates.sh"} onChange={(e) => { editedGate.current = true; setGate(e.target.value); }} />
        </label>
        <p className="fa-config-description">A successful exit code is required before continuing. Passing checks is not a guarantee of production readiness.</p>
        <div className="fa-config-actions">
          <button type="submit" className="rs-button rs-button--primary" disabled={busy || !valid || (!setup && gate.trim() === definition?.gate)}>{busy ? "Saving…" : setup ? "Set up private factory" : "Save checks"}</button>
          <span className="fa-config-unverified">Saving only updates configuration.</span>
        </div>
      </form>}
      {!broken && source.checks ? <FactoryTryChecks key={`${repo}:${checkout}`} source={source.checks} checkout={checkout} repo={repo} base={view.base} command={gate.trim()} shell={privateFactory} disabled={busy || !valid} /> : null}
      {error ? <p role="alert" className="fa-agents-alert">{error}</p> : null}
      {(definition || broken) && privateFactory ? <div className="fa-config-management">
        {confirming ? <>
          <h3>Remove local Factory configuration?</h3>
          <p>This removes local settings and agent customizations. It does not delete repository code, plugins, worktrees, or run history. Unfinished runs must be completed or cancelled first.</p>
          <div className="fa-config-actions">
            <button type="button" className="rs-button fa-remove-config" disabled={busy} onClick={() => void operate(async () => {
              const id = await source.removePrivate(repo); setRecovery(id); setConfirming(false);
            }, "Local Factory configuration removed.")}>Remove configuration</button>
            <button type="button" className="rs-button" disabled={busy} onClick={() => { setConfirming(false); setError(null); }}>Cancel</button>
          </div>
        </> : <button type="button" className="rs-button" disabled={busy} onClick={() => setConfirming(true)}>Remove local factory</button>}
      </div> : null}
    </section>
  );
}

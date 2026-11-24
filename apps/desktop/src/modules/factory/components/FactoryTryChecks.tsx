"use client";
import { useFactoryCheckTrial } from "../hooks/useFactoryCheckTrial";
import { checkTrialLabel, checkTrialLabels, type FactoryCheckTrialSource } from "../services/factory-check-trial";

/** Explicit approval boundary. Inspecting/saving configuration never starts these checks. */
export function FactoryTryChecks({ source, checkout, repo, base, command, shell, disabled }: {
  source: FactoryCheckTrialSource; checkout: string; repo: string; base: string | null;
  command: string; shell: boolean; disabled: boolean;
}) {
  const state = useFactoryCheckTrial(source, checkout, repo, base, command, shell);
  const { preview, trial, flight, error, statusError, cancelling } = state;
  const running = trial?.status === "running";
  const label = statusError ? "Status unavailable" : checkTrialLabel(trial, command, base, shell);
  const matches = preview?.command === command && preview?.base === base && preview?.shell === shell;
  return <section className="fa-try-checks" aria-label="Check verification">
    <div className="fa-config-actions">
      <button type="button" className="rs-button" disabled={disabled || Boolean(flight) || running || !command || !base} onClick={() => void state.review()}>{flight === "preview" ? "Preparing preview…" : "Try checks"}</button>
      <span role="status" className="fa-check-verdict">{label}</span>
      {trial ? <span className="fa-config-unverified">{Math.floor(trial.elapsedMs / 1000)}s{trial.exitCode !== null ? ` · exit ${trial.exitCode}` : ""}</span> : null}
      {running ? <button type="button" className="rs-button" disabled={flight === "cancel" || cancelling} onClick={() => void state.cancel()}>{cancelling ? "Stopping checks…" : "Cancel checks"}</button> : null}
    </div>
    {!trial ? <p className="fa-config-description">Verify this command before relying on it. Lotus does not start agents, push changes or open a PR for this trial.</p> : null}
    {preview && matches ? <div className="fa-check-confirmation">
      <h3>Run checks in a separate worktree?</h3>
      <dl className="fa-check-context">
        <dt>{preview.shell ? "Command" : "Script"}</dt><dd><code>{preview.command}</code></dd>
        <dt>Revision</dt><dd><code>origin/{preview.base} · {preview.revision.slice(0, 12)}</code> (cached, no fetch)</dd>
        <dt>Location</dt><dd><code>{preview.worktree}</code></dd>
        <dt>Time limit</dt><dd>{Math.floor(preview.timeoutSeconds / 60)} minutes</dd>
      </dl>
      <p className="fa-config-description">A fresh detached worktree is created from this revision, then removed when the trial finishes. Only committed files are checked out. Uncommitted and ignored files are not copied, including local .env or dependency folders. Lotus does not install dependencies for you.</p>
      <p className="fa-config-description">This is not a security sandbox. Checks can use your login environment, access host files and network, and have side effects. Only run trusted repository checks.</p>
      <div className="fa-config-actions">
        <button type="button" className="rs-button rs-button--primary" disabled={disabled || Boolean(flight) || running} onClick={() => void state.start()}>{flight === "start" ? "Starting checks…" : "Run checks now"}</button>
        <button type="button" className="rs-button" disabled={Boolean(flight)} onClick={state.dismiss}>Back</button>
      </div>
    </div> : null}
    {trial ? <>
      <p className="fa-config-description">{trial.message}</p>
      <p className="fa-config-description">Tested <code>{trial.command}</code> on <code>origin/{trial.base} · {trial.revision.slice(0, 12)}</code>. Last trial: {checkTrialLabels[trial.status]}. Passing applies only to that command and revision, not production readiness.</p>
      {trial.output ? <details className="fa-check-output" open>
        <summary>Check output (latest 16 KB)</summary>
        <pre aria-label="Check output" tabIndex={0}>{trial.output}</pre>
        <p className="fa-config-description">Output is kept only for this desktop session, not saved to disk or sent to agents. It can contain sensitive project data.</p>
      </details> : null}
    </> : null}
    {error ? <p role="alert" className="fa-agents-alert">{error}</p> : null}
    {statusError ? <p role="alert" className="fa-agents-alert">{statusError}</p> : null}
  </section>;
}

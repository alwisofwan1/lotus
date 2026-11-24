"use client";

import { X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ResourceSearch } from "@/components/resource/resource-kit";
import { NumberStepper } from "@/components/ui/number-stepper";
import { compareRefs, factoryRefLabel, type FactoryRef, type FactoryRunState } from "../services/factory-run";
import {
  busyIssues,
  busyIssuesInWorkspace,
  DEFAULT_CAP_USD,
  FACTORY_MAX_ATTEMPTS,
  filterIssues,
  implementerChoice,
  newRunFooter,
  prsGoInto,
  type FactoryBatchResult,
  type FactoryNewRunSource,
  type FactoryRepoDefaults,
  type FactoryWorkspaceInfo,
} from "../services/factory-new-run";
import {
  keepNotionRepo as keepRepo,
  keepNotionWorkspace as keepWorkspace,
  keptNotionRepo as keptRepo,
  keptNotionWorkspace as keptWorkspace,
} from "../services/factory-notion";
import "@/styles/factory.css";

/**
 * Start many Factory Runs at once: pick a repo (or a Notion database and the repo its code is in), tick its open tickets, pick the implementer and the
 * cap, then Start. Each issue gets its own run. The tickets are the sheet; implementer and cap are one
 * quiet strip beside Start, the implementer starting at the Implement role's preset in Settings. An issue whose run is still going, or whose draft
 * PR is still open, is shown but cannot be ticked. When some fail to start, the sheet stays open with
 * those still ticked and why under each one.
 */
export function FactoryNewRunSheet({
  source,
  rows,
  onClose,
}: {
  source: FactoryNewRunSource;
  rows: readonly { repo: string; issue: FactoryRef; state: FactoryRunState; ticket?: { checkout: string } }[];
  onClose: () => void;
}) {
  const headingId = useId();
  const notionSources = source.notion ?? [];
  // Where the tickets come from: a repo's issues, or a Notion database.
  const [sourceId, setSourceId] = useState(source.repos[0]?.id ?? notionSources[0]?.id ?? "");
  const notion = notionSources.find((n) => n.id === sourceId) ?? null;
  const [notionRepoId, setNotionRepoId] = useState<string | null>(() => (notion ? keptRepo(notion.id) : null));
  const workspaces = source.workspaces ?? [];
  const [workspaceId, setWorkspaceId] = useState<string | null>(() => (notion ? keptWorkspace(notion.id) : null));
  const [info, setInfo] = useState<{ path: string; info: FactoryWorkspaceInfo } | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<FactoryRef>>(new Set());
  const [presets, setPresets] = useState<{ id: string; name: string }[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [fromSettings, setFromSettings] = useState<string | null>(null);
  const [base, setBase] = useState<FactoryRepoDefaults["base"]>(null);
  const [capUsd, setCapUsd] = useState(DEFAULT_CAP_USD);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<{ results: FactoryBatchResult[]; asked: number } | null>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void source
      .presets()
      .catch(() => [])
      .then((list) => {
        if (cancelled) return;
        setPresets(list);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  // A Notion run with Workspaces works in a local folder; its repo is the one that folder is.
  const workspace = notion && workspaces.length > 0 ? (workspaces.find((w) => w.id === workspaceId) ?? workspaces[0]) : null;
  const workspacePath = workspace?.path ?? null;
  const workspaceInfo = info && info.path === workspacePath ? info.info : null;
  useEffect(() => {
    if (!workspacePath || !source.inspectWorkspace) return;
    let cancelled = false;
    void source
      .inspectWorkspace(workspacePath)
      .catch((): FactoryWorkspaceInfo => ({ repo: null, subRepos: [] }))
      .then((found) => {
        if (!cancelled) setInfo({ path: workspacePath, info: found });
      });
    return () => {
      cancelled = true;
    };
  }, [workspacePath, source]);
  const repoId = notion ? (source.repos.some((r) => r.id === notionRepoId) ? notionRepoId : source.repos[0]?.id) : sourceId;
  const repo = workspace ? (workspaceInfo?.repo ?? null) : (source.repos.find((r) => r.id === repoId) ?? null);
  const issues = useMemo(() => (sourceId ? source.issues(sourceId) : []), [sourceId, source]);
  const shown = filterIssues(issues, query);
  const held = workspacePath
    ? busyIssuesInWorkspace(rows, workspacePath)
    : repo
      ? busyIssues(rows, repo.repo)
      : new Map<FactoryRef, "running" | "pr-open">();
  const choice = implementerChoice(presets ?? [], fromSettings, chosen);
  const implementer = choice.id;
  const count = picked.size;
  const canStart = count > 0 && Boolean(implementer) && !busy && repo !== null;
  const pickable = shown.filter((issue) => !held.has(issue.number));
  const allPicked = pickable.length > 0 && pickable.every((issue) => picked.has(issue.number));
  const reasons = new Map((failed?.results ?? []).map((r) => [r.issue, r.error]));

  // Per repo, from the definition the next run reads: the Implement role's preset in Settings
  // starts the implementer, and the branch its PRs go into is shown.
  const repoName = repo?.repo ?? null;
  useEffect(() => {
    setBase(null);
    if (!repoName || !source.defaultsOf) return;
    let cancelled = false;
    void source
      .defaultsOf(repoName)
      .catch(() => null)
      .then((defaults) => {
        if (cancelled) return;
        setFromSettings(defaults?.implementer ?? null);
        setBase(defaults?.base ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [repoName, source]);

  const toggleAll = () =>
    setPicked((current) => {
      const next = new Set(current);
      for (const issue of pickable) {
        if (allPicked) next.delete(issue.number);
        else next.add(issue.number);
      }
      return next;
    });

  const toggle = (n: FactoryRef) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  const changeSource = (id: string) => {
    setSourceId(id);
    if (notionSources.some((n) => n.id === id)) {
      setNotionRepoId(keptRepo(id));
      setWorkspaceId(keptWorkspace(id));
    }
    setPicked(new Set());
    setFailed(null);
  };

  const changeWorkspace = (id: string) => {
    if (notion) keepWorkspace(notion.id, id);
    setWorkspaceId(id);
    setPicked(new Set());
    setFailed(null);
  };

  const changeRepo = (id: string) => {
    if (notion) {
      keepRepo(notion.id, id);
      setNotionRepoId(id);
    } else {
      setSourceId(id);
      setPicked(new Set());
    }
    setFailed(null);
  };

  const start = async () => {
    if (!repo || !canStart) return;
    setBusy(true);
    setFailed(null);
    const asked = [...picked].sort(compareRefs);
    try {
      const results = await source.start({ repo, sourceId, issues: asked, implementer, capUsd, ...(workspacePath ? { workspace: workspacePath } : {}), ...(workspaceInfo?.meta ? { meta: true, repoAccounts: Object.fromEntries(source.repos.map((r) => [r.repo, r.account])) } : {}) });
      const errors = results.filter((r) => r.error !== null);
      if (errors.length === 0) {
        onClose();
        return;
      }
      setPicked(new Set(errors.map((r) => r.issue)));
      setFailed({ results: errors, asked: asked.length });
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause);
      setFailed({ results: asked.map((issue) => ({ issue, error })), asked: asked.length });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fa-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="fa-modal"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header className="fa-modal-head">
          <div>
            <h2 id={headingId}>New run</h2>
            <p className="fa-modal-sub">Each ticket you tick gets its own run and its own draft PR.</p>
          </div>
          <button type="button" className="rs-icon-button" onClick={onClose} aria-label="Close">
            <X size={15} strokeWidth={1.75} aria-hidden />
          </button>
        </header>

        <div className="fa-modal-row">
          {notionSources.length > 0 ? (
            <label className="fa-pick">
              <span className="fa-pick-key">Tickets from</span>
              <select aria-label="Tickets from" value={sourceId} onChange={(event) => changeSource(event.target.value)}>
                {source.repos.length > 0 ? (
                  <optgroup label="GitHub issues">
                    {source.repos.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                <optgroup label="Notion">
                  {notionSources.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
          ) : null}
          {workspace ? (
            <label className="fa-pick">
              <span className="fa-pick-key">Workspace</span>
              <select aria-label="Workspace" value={workspace.id} onChange={(event) => changeWorkspace(event.target.value)}>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          ) : notion === null && notionSources.length > 0 ? null : source.repos.length > 1 ? (
            <label className="fa-pick">
              <span className="fa-pick-key">{notion ? "Code in" : "Repository"}</span>
              <select aria-label={notion ? "Code in" : "Repository"} value={repoId ?? ""} onChange={(event) => changeRepo(event.target.value)}>
                {source.repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="fa-field-value">{repo ? (notion ? `Code in ${repo.name}` : repo.name) : "No GitHub repository connected"}</p>
          )}
          {workspaceInfo && workspaceInfo.subRepos.length > 0 ? (
            <p className="fa-field-hint">Sub-repos: {workspaceInfo.subRepos.join(", ")}</p>
          ) : null}
          {workspaceInfo?.meta ? (
            <p className="fa-field-hint">Meta-repo: triage picks the sub-repo for each ticket.</p>
          ) : null}
          {workspaceInfo && !workspaceInfo.repo ? (
            <p className="fa-field-hint">No connected GitHub repo is this folder and it has no sub-repos, so a run cannot start here.</p>
          ) : null}
          {base ? (
            <p className="fa-field-hint">{prsGoInto(base)}</p>
          ) : null}
          <ResourceSearch value={query} onChange={setQuery} placeholder={notion ? "Search tickets" : "Search issues"} />
        </div>

        {pickable.length > 0 ? (
          <div className="fa-issue-head">
            <label className="fa-issue-all">
              <input type="checkbox" className="fa-tick" checked={allPicked} onChange={toggleAll} />
              Select all {pickable.length}
            </label>
            <span className="fa-card-meta">{count > 0 ? `${count} selected` : null}</span>
          </div>
        ) : null}

        <ul className="fa-issue-list" aria-label={notion ? "Open tickets" : "Open issues"}>
          {shown.length === 0 ? (
            <li className="fa-issue-empty">
              {issues.length > 0
                ? "Nothing matches."
                : notion
                  ? "No open tickets in Tasks for this Notion database yet."
                  : "No open issues in Tasks for this repo yet."}
            </li>
          ) : (
            shown.map((issue) => {
              const holder = held.get(issue.number);
              const isBusy = holder !== undefined;
              const isPicked = picked.has(issue.number);
              const reason = reasons.get(issue.number);
              const label = `${factoryRefLabel(issue.number)} ${issue.title}`;
              return (
                <li key={issue.number} className="fa-issue" data-busy={isBusy ? "true" : undefined} data-picked={isPicked ? "true" : undefined}>
                  <label>
                    <input
                      type="checkbox"
                      className="fa-tick"
                      aria-label={label}
                      checked={isPicked}
                      disabled={isBusy}
                      onChange={() => toggle(issue.number)}
                    />
                    <span className="fa-issue-num">{factoryRefLabel(issue.number)}</span>
                    <span className="fa-issue-title">{issue.title}</span>
                    {holder ? <span className="fa-issue-note">{holder === "pr-open" ? "draft PR open" : "already running"}</span> : null}
                  </label>
                  {reason ? <p className="fa-issue-reason">Did not start: {reason}</p> : null}
                </li>
              );
            })
          )}
        </ul>

        {presets && presets.length === 0 ? <p className="fa-card-meta">Make a Claude preset first (Delegate → New preset).</p> : null}

        {failed ? (
          <p role="alert" className="fa-error">
            {failed.asked - failed.results.length} of {failed.asked} started. The ones still ticked did not; the reason is under each.
          </p>
        ) : null}

        <footer className="fa-modal-foot">
          <div className="fa-run-settings">
            <label className="fa-pick">
              <span className="fa-pick-key">Implementer</span>
              <select
                aria-label="Implementer"
                value={implementer}
                disabled={!presets || presets.length === 0}
                onChange={(event) => setChosen(event.target.value)}
              >
                {(presets ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {presets && presets.length > 0 ? <span className="fa-pick-cap">{choice.caption}</span> : null}
            </label>
            <div className="fa-pick">
              <span className="fa-pick-key">Cap / run</span>
              <NumberStepper label="Cap per run (USD)" min={0.5} max={500} step={0.5} unit="USD" value={capUsd} onChange={setCapUsd} />
              <span className="fa-pick-cap" title="Fixed by the Factory runner">
                {FACTORY_MAX_ATTEMPTS} tries
              </span>
            </div>
          </div>
          <div className="fa-run-go">
            <span className="fa-card-meta">{newRunFooter(count, capUsd)}</span>
            <button type="button" className="rs-button rs-button--primary" disabled={!canStart} onClick={() => void start()}>
              {busy ? "Starting…" : count === 1 ? "Start 1 run" : `Start ${count} runs`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

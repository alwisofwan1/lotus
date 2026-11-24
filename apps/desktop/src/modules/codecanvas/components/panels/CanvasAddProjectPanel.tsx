"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ChevronRight,
  Folder,
  Laptop,
  Lock,
  Plug,
  Search,
} from "lucide-react";
import {
  listDirEntriesSsh,
  listSshHosts,
  machineAccessLogin,
  machineReadiness,
  type DirEntry,
  type MachineReadiness,
  type SshConfigHost,
} from "@/lib/tauri-api";
import type { CodeCanvasProjectLocation, CodeCanvasProjectMeta } from "@/lib/tauri/codecanvas";
import {
  addProjectChoices,
  machineFromQuery,
  type AddProjectMachineChoice,
} from "../../services/add-project";
import { useCanvasOcclusionLock } from "../../hooks/useCanvasOcclusionLock";
import { describeRemoteFailure, type RemoteFailure } from "../../services/remote-failure";
import {
  browseCrumbs,
  initialBrowsePath,
  parentBrowsePath,
} from "../../services/remote-browse";
import { machineFromLocation, machineKey } from "../../services/machine";

interface Props {
  projects: readonly CodeCanvasProjectMeta[];
  /** Pick a folder on this machine — the existing native dialog. */
  onPickLocalFolder: () => void;
  onOpenProject: (rootDir: string, location: CodeCanvasProjectLocation | null) => void;
  onClose: () => void;
}

type Machine = AddProjectMachineChoice;

/** How often the sign-in screen asks whether the browser sign-in has landed. */
const SIGN_IN_POLL_MS = 2000;

/**
 * Document-level keys for a palette. Focus moves between a search field and row buttons as the
 * mouse is used, so a handler on one element would go deaf half the time. A focused button that is
 * not a palette row (back, crumbs, "Use this folder") keeps its own Enter.
 */
function usePaletteKeys(handler: (event: KeyboardEvent) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const foreignButton = target?.closest?.("button") && !target.closest("[data-row]");
      if (foreignButton && event.key !== "Escape") return;
      latest.current(event);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="canvas-addproject-kbd">{children}</kbd>;
}

function Legend({ keys, note }: { keys: { k: string; label: string }[]; note?: string }) {
  return (
    <footer className="canvas-addproject-legend">
      {keys.map((entry) => (
        <span key={entry.k}><Kbd>{entry.k}</Kbd> {entry.label}</span>
      ))}
      {note ? <span className="canvas-addproject-legend-note">{note}</span> : null}
    </footer>
  );
}

function BackHeader({
  machine,
  onBack,
  children,
}: {
  machine: Machine;
  onBack: () => void;
  children?: React.ReactNode;
}) {
  return (
    <header className="canvas-addproject-bhead">
      <button type="button" className="canvas-addproject-back" onClick={onBack} aria-label="Back to machines">
        <ChevronRight size={15} style={{ transform: "rotate(180deg)" }} aria-hidden />
      </button>
      <span className="canvas-addproject-mpill">{machine.label}</span>
      {children}
    </header>
  );
}

/**
 * Add a project — on this machine or another one — as one command palette rather than a sequence
 * of questions (`mockups/workspace-create-revamp.html`, screens 2–5).
 *
 * Choosing a machine, then browsing it. Browsing only appears once a machine is chosen, so the
 * common case (a local folder) is still one keystroke from the top of the list.
 */
export function CanvasAddProjectPanel({ projects, onPickLocalFolder, onOpenProject, onClose }: Props) {
  // A Canvas Browser Node's native WebView paints above the whole DOM, so an overlay that does not
  // park it is simply covered by a web page. Held for the panel's whole life, every screen.
  useCanvasOcclusionLock(true, "add-project");

  const [hosts, setHosts] = useState<SshConfigHost[]>([]);
  const [query, setQuery] = useState("");
  const [machine, setMachine] = useState<Machine | null>(null);
  const [readiness, setReadiness] = useState<Record<string, MachineReadiness>>({});
  const [signingIn, setSigningIn] = useState<Machine | null>(null);
  /** The URL cloudflared says it opened — the fallback when the browser did not actually come up. */
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [showGitOnly, setShowGitOnly] = useState(false);
  const [hl, setHl] = useState(0);

  useEffect(() => {
    let live = true;
    void listSshHosts()
      .then((found) => { if (live) setHosts(found); })
      .catch(() => { /* no ~/.ssh/config is a normal state, not a fault */ });
    return () => { live = false; };
  }, []);

  const choices = useMemo(
    () => addProjectChoices({ hosts, projects, query }),
    [hosts, projects, query],
  );
  const typed = useMemo(() => machineFromQuery(query, choices), [query, choices]);
  const local = choices.find((choice) => choice.kind === "local");
  const machines = choices.filter((choice): choice is Machine => choice.kind === "machine");
  const usable = machines.filter((m) => !m.disabledReason);
  const gitOnly = machines.filter((m) => m.disabledReason);

  // Readiness is asked once per machine, in parallel, and never blocks the list from painting: the
  // rows are useful before their labels arrive, and a machine that cannot answer simply stays
  // unlabelled rather than claiming a state we did not verify.
  const machineIds = usable.map((choice) => choice.id).join("|");
  useEffect(() => {
    if (!machineIds) return;
    let live = true;
    void Promise.all(
      usable.map(async (row) => {
        try {
          return [row.id, await machineReadiness(row.target, row.accessHostname)] as const;
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (!live) return;
      const next: Record<string, MachineReadiness> = {};
      for (const result of results) {
        if (result) next[result[0]] = result[1];
      }
      setReadiness((prev) => ({ ...prev, ...next }));
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- machineIds stands in for the rows
  }, [machineIds]);

  const pickMachine = useCallback((picked: Machine) => {
    const state = readiness[picked.id];
    // Choosing a machine whose browser sign-in has lapsed opens that sign-in, because browsing it
    // would otherwise wait for SSH before reporting a missing browser sign-in.
    if (state?.access?.state === "needs-login" && !state.connected) {
      setSigningIn(picked);
      setLoginUrl(null);
      void machineAccessLogin(state.access.hostname)
        .then(setLoginUrl)
        .catch(() => {
          // The panel still shows the machine and its fallback; a failed spawn changes nothing here.
        });
      return;
    }
    setMachine(picked);
  }, [readiness]);

  // Sign-in: ask again every 2 s and move on by ourselves. The cleanup is the stale-attempt guard —
  // leaving the screen (back, continue, unmount) stops the timer, and `live` drops an answer that
  // was already in flight.
  const signingInId = signingIn?.id;
  useEffect(() => {
    if (!signingIn) return;
    const target = signingIn;
    let live = true;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void machineReadiness(target.target, target.accessHostname)
        .then((fresh) => {
          if (!live) return;
          setReadiness((prev) => ({ ...prev, [target.id]: fresh }));
          if (fresh.connected || fresh.access?.state === "signed-in") {
            setSigningIn(null);
            setMachine(target);
          }
        })
        .catch(() => { /* not signed in yet, or the probe failed: keep waiting */ })
        .finally(() => { inFlight = false; });
    }, SIGN_IN_POLL_MS);
    return () => { live = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the id identifies the attempt
  }, [signingInId]);

  // What the keyboard can reach on the list screen, top to bottom.
  const items = useMemo(() => {
    const out: { key: string; run: () => void }[] = [];
    if (typed) out.push({ key: typed.id, run: () => pickMachine(typed) });
    if (local) out.push({ key: "local", run: () => { onPickLocalFolder(); onClose(); } });
    for (const m of usable) out.push({ key: m.id, run: () => pickMachine(m) });
    return out;
  }, [typed, local, usable, pickMachine, onPickLocalFolder, onClose]);

  const itemCount = items.length;
  useEffect(() => { setHl(0); }, [query, itemCount]);

  usePaletteKeys((event) => {
    if (signingIn) {
      if (event.key === "Escape") { event.preventDefault(); setSigningIn(null); }
      return;
    }
    if (machine) return; // the browser owns its own keys
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); setHl((i) => Math.min(i + 1, itemCount - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setHl((i) => Math.max(i - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); items[hl]?.run(); }
  });

  if (signingIn) {
    const hostname = readiness[signingIn.id]?.access?.hostname ?? signingIn.label;
    return (
      <div className="canvas-addproject" role="dialog" aria-label="Sign in with Cloudflare Access">
        <BackHeader machine={signingIn} onBack={() => setSigningIn(null)} />
        <div className="canvas-addproject-signin">
          <div className="canvas-addproject-lock"><Lock size={22} aria-hidden /></div>
          <h2>Sign in to reach {signingIn.label}</h2>
          <p>
            This machine sits behind Cloudflare Access. We opened the sign-in page for{" "}
            <code>{hostname}</code> in your browser. Finish there — this window moves on by itself.
          </p>
          <div className="canvas-addproject-wait" role="status">
            <span className="canvas-addproject-spinner" aria-hidden />
            Waiting for sign-in…
          </div>
          <div className="canvas-addproject-links">
            {/* Fallback for a check that never reports signed-in: browsing shows the failure card if it really is not. */}
            <button
              type="button"
              className="canvas-addproject-ghost canvas-addproject-ghost-bd"
              onClick={() => { const target = signingIn; setSigningIn(null); setMachine(target); }}
            >
              I&apos;ve signed in, continue
            </button>
            <button
              type="button"
              className="canvas-addproject-ghost canvas-addproject-ghost-bd"
              onClick={() => { void machineAccessLogin(hostname).then(setLoginUrl).catch(() => {}); }}
            >
              Open again
            </button>
            {loginUrl ? (
              <button
                type="button"
                className="canvas-addproject-ghost canvas-addproject-ghost-bd"
                onClick={() => { void navigator.clipboard?.writeText(loginUrl).catch(() => {}); }}
              >
                Copy link
              </button>
            ) : null}
          </div>
          {loginUrl ? (
            <div className="canvas-addproject-loginurl">
              <p>Browser did not open? Open this link:</p>
              <code>{loginUrl}</code>
            </div>
          ) : null}
        </div>
        <Legend keys={[{ k: "Esc", label: "back" }]} />
      </div>
    );
  }

  if (machine) {
    return (
      <RemoteFolderBrowser
        machine={machine}
        projects={projects}
        onBack={() => setMachine(null)}
        onUse={(path) => {
          onOpenProject(path, { kind: "ssh", ...machine.target });
          onClose();
        }}
      />
    );
  }

  const hlKey = items[hl]?.key;
  const hover = (key: string) => {
    const index = items.findIndex((item) => item.key === key);
    if (index >= 0) setHl(index);
  };

  return (
    <div className="canvas-addproject" role="dialog" aria-label="Add project">
      <div className="canvas-addproject-search">
        <Search size={17} aria-hidden />
        <input
          value={query}
          autoFocus
          spellCheck={false}
          placeholder="Search machines, or type user@host to add one"
          aria-label="Search machines, or type an address"
          onChange={(event) => setQuery(event.target.value)}
        />
        <Kbd>Esc</Kbd>
      </div>

      <div className="canvas-addproject-body">
        {typed ? (
          <>
            <div className="canvas-addproject-grp">New machine</div>
            <MachineRow
              machine={typed}
              title={`Connect to ${typed.detail}`}
              icon={<Plug size={15} aria-hidden />}
              pill={<span className="canvas-addproject-pill" data-tone="new">New</span>}
              highlighted={hlKey === typed.id}
              onHover={() => hover(typed.id)}
              onPick={pickMachine}
            />
          </>
        ) : null}

        {local ? (
          <>
            <div className="canvas-addproject-grp">This Mac</div>
            <button
              type="button"
              data-row
              className="canvas-addproject-row"
              data-hl={hlKey === "local" ? "true" : undefined}
              onMouseMove={() => hover("local")}
              onClick={() => { onPickLocalFolder(); onClose(); }}
            >
              <span className="canvas-addproject-ic"><Laptop size={15} aria-hidden /></span>
              <span className="canvas-addproject-main">
                <span className="canvas-addproject-name">{local.label}</span>
                <span className="canvas-addproject-sub">{local.detail}</span>
              </span>
              <Kbd>↵</Kbd>
            </button>
          </>
        ) : null}

        {usable.length > 0 || gitOnly.length > 0 ? (
          <div className="canvas-addproject-grp">
            Remote machines <span>{usable.length}</span>
          </div>
        ) : null}
        {usable.map((m) => (
          <MachineRow
            key={m.id}
            machine={m}
            readiness={readiness[m.id]}
            highlighted={hlKey === m.id}
            onHover={() => hover(m.id)}
            onPick={pickMachine}
          />
        ))}

        {gitOnly.length > 0 ? (
          <>
            <button
              type="button"
              className="canvas-addproject-fold"
              data-open={showGitOnly ? "true" : undefined}
              aria-expanded={showGitOnly}
              onClick={() => setShowGitOnly((open) => !open)}
            >
              <ChevronRight size={11} aria-hidden />
              {showGitOnly
                ? `Hide ${gitOnly.length} Git-only SSH ${gitOnly.length === 1 ? "alias" : "aliases"}`
                : `${gitOnly.length} Git-only SSH ${gitOnly.length === 1 ? "alias" : "aliases"} hidden — they can't host a project`}
            </button>
            {showGitOnly
              ? gitOnly.map((m) => (
                  <MachineRow key={m.id} machine={m} highlighted={false} onHover={() => {}} onPick={pickMachine} />
                ))
              : null}
          </>
        ) : null}

        {usable.length === 0 && !typed ? (
          <p className="canvas-addproject-empty">
            {query
              ? "No machine matches. Type the full address — for example root@103.20.10.5."
              : "~/.ssh/config does not list a usable host yet. Type an address and we will try to connect."}
          </p>
        ) : null}
      </div>

      <Legend
        keys={[{ k: "↑↓", label: "move" }, { k: "↵", label: "open" }]}
        note="From ~/.ssh/config + your projects"
      />
    </div>
  );
}

/**
 * What a machine's label says, and why each state earns its own word.
 *
 * Only two states are ever asserted, because only two are known for free: a live SSH master means
 * *connected*, and a missing Cloudflare Access token means *sign in*. Everything else is
 * deliberately silent — a machine we have not spoken to must not be labelled "ready", and a probe
 * to find out would cost the operator the very seconds this flow exists to give back.
 */
function readinessLabel(state?: MachineReadiness): { text: string; tone: "live" | "attention" } | null {
  if (!state) return null;
  if (state.connected) return { text: "Connected", tone: "live" };
  if (state.access?.state === "needs-login") return { text: "Sign in", tone: "attention" };
  return null;
}

function MachineRow({
  machine,
  readiness,
  title,
  icon,
  pill,
  highlighted,
  onHover,
  onPick,
}: {
  machine: Machine;
  readiness?: MachineReadiness;
  title?: string;
  icon?: React.ReactNode;
  pill?: React.ReactNode;
  highlighted: boolean;
  onHover: () => void;
  onPick: (machine: Machine) => void;
}) {
  const disabled = Boolean(machine.disabledReason);
  const label = readinessLabel(readiness);
  const dot = readiness?.connected ? "live" : label?.tone === "attention" ? "attention" : null;
  return (
    <button
      type="button"
      data-row
      className="canvas-addproject-row"
      data-hl={highlighted ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
      disabled={disabled}
      onMouseMove={onHover}
      onClick={() => onPick(machine)}
    >
      <span className="canvas-addproject-ic">
        {icon ?? machine.label.slice(0, 1).toUpperCase()}
        {dot ? <span className="canvas-addproject-st" data-state={dot} aria-hidden /> : null}
      </span>
      <span className="canvas-addproject-main">
        <span className="canvas-addproject-name">
          {title ?? machine.label}
          {label ? (
            <span className="canvas-addproject-pill" data-tone={label.tone}>{label.text}</span>
          ) : null}
          {pill}
        </span>
        <span className="canvas-addproject-sub canvas-addproject-mono">
          {machine.disabledReason ?? machine.detail}
        </span>
      </span>
      {!disabled && !pill ? (
        <span className="canvas-addproject-tail">
          {machine.projectCount > 0
            ? `${machine.projectCount} ${machine.projectCount === 1 ? "project" : "projects"}`
            : "No projects yet"}
        </span>
      ) : null}
    </button>
  );
}

function projectName(project: CodeCanvasProjectMeta): string {
  return project.alias?.trim() || project.rootDir.replace(/\/+$/, "").split("/").pop() || project.rootDir;
}

function RemoteFolderBrowser({
  machine,
  projects,
  onBack,
  onUse,
}: {
  machine: Machine;
  projects: readonly CodeCanvasProjectMeta[];
  onBack: () => void;
  onUse: (path: string) => void;
}) {
  // `path` is the single source of truth: navigating only moves it, and the listing follows. The
  // alternative — fetch first, then set the path on success — leaves the breadcrumb lying about
  // where you are for the length of a round trip.
  const [path, setPath] = useState(() => initialBrowsePath(machine.target));
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [busy, setBusy] = useState(true);
  const [failure, setFailure] = useState<RemoteFailure | null>(null);
  // Bumped to ask the same directory again — a retry must re-run the effect even though `path`
  // has not moved.
  const [attempt, setAttempt] = useState(0);
  /** A click only selects; going in is Enter, → or a double click. */
  const [selected, setSelected] = useState<string | null>(null);
  const [hl, setHl] = useState(0);

  useEffect(() => {
    let live = true;
    listDirEntriesSsh(machine.target, path)
      .then((found) => {
        if (!live) return;
        setEntries(found);
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (!live) return;
        setEntries([]);
        setFailure(describeRemoteFailure(error, machine.label));
      })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [machine.target, machine.label, path, attempt]);

  const load = useCallback((next: string) => {
    setBusy(true);
    setSelected(null);
    setHl(0);
    setPath(next);
  }, []);

  const retry = useCallback(() => {
    setBusy(true);
    setAttempt((n) => n + 1);
  }, []);

  const up = parentBrowsePath(path);
  const crumbs = browseCrumbs(path);
  const dirName = crumbs[crumbs.length - 1]?.label ?? "/";

  const known = useMemo(
    () => projects.filter((p) => machineKey(machineFromLocation(p.location)) === machine.id),
    [projects, machine.id],
  );
  const listed = !busy && !failure;
  const knownShown = listed ? known : [];
  const rowCount = knownShown.length + (listed ? entries.length : 0);

  const openProject = (root: string) => onUse(root);
  const selectedEntry = entries.find((entry) => entry.path === selected);
  const canUse = listed;

  // The arrow keys select as they move, so ⌘↵ always acts on what the highlight is on.
  const focusRow = (index: number) => {
    setHl(index);
    const entry = entries[index - knownShown.length];
    setSelected(entry ? entry.path : null);
  };

  usePaletteKeys((event) => {
    if (event.key === "Escape") { event.preventDefault(); onBack(); return; }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      if (!canUse) return;
      event.preventDefault();
      onUse(selected ?? path);
      return;
    }
    if (!listed) return;
    const entry = hl >= knownShown.length ? entries[hl - knownShown.length] : undefined;
    const project = hl < knownShown.length ? knownShown[hl] : undefined;
    if (event.key === "ArrowDown") { event.preventDefault(); focusRow(Math.min(hl + 1, rowCount - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); focusRow(Math.max(hl - 1, 0)); }
    else if (event.key === "Enter") {
      event.preventDefault();
      if (project) openProject(project.rootDir);
      else if (entry) load(entry.path);
    } else if (event.key === "ArrowRight") {
      if (entry) { event.preventDefault(); load(entry.path); }
    } else if (event.key === "ArrowLeft") {
      if (up) { event.preventDefault(); load(up); }
    }
  });

  return (
    <div className="canvas-addproject" role="dialog" aria-label="Choose a project folder">
      <BackHeader machine={machine} onBack={onBack}>
        <nav className="canvas-addproject-crumbs" aria-label="Folder path">
          {crumbs.map((crumb, index, all) => (
            <span key={crumb.path} className="canvas-addproject-crumb">
              {index > 1 ? <i>/</i> : null}
              <button
                type="button"
                data-current={index === all.length - 1 ? "true" : undefined}
                onClick={() => load(crumb.path)}
              >
                {crumb.label}
              </button>
            </span>
          ))}
        </nav>
      </BackHeader>

      <div className="canvas-addproject-body">
        {busy ? (
          <div className="canvas-addproject-loading" role="status" aria-label={`Reading ${path}`}>
            <span className="canvas-addproject-skel" />
            <span className="canvas-addproject-skel" />
            <span className="canvas-addproject-skel" />
          </div>
        ) : failure ? (
          <div className="canvas-addproject-fail" role="alert">
            <p className="canvas-addproject-fail-title">
              <AlertCircle size={15} aria-hidden /> {failure.title}
            </p>
            <p className="canvas-addproject-fail-action">{failure.action}</p>
            <div className="canvas-addproject-fail-actions">
              <button type="button" className="canvas-addproject-primary" onClick={retry}>
                Try again
              </button>
              {up ? (
                <button
                  type="button"
                  className="canvas-addproject-ghost canvas-addproject-ghost-bd"
                  onClick={() => load(up)}
                >
                  Go up one level
                </button>
              ) : null}
            </div>
            <details className="canvas-addproject-fail-detail">
              <summary>Technical details</summary>
              <p>{failure.detail}</p>
            </details>
          </div>
        ) : (
          <>
            {knownShown.length > 0 ? (
              <>
                <div className="canvas-addproject-grp">
                  On this machine <span>{knownShown.length} {knownShown.length === 1 ? "project" : "projects"}</span>
                </div>
                {knownShown.map((project, index) => (
                  <button
                    key={project.id}
                    type="button"
                    data-row
                    className="canvas-addproject-row"
                    data-hl={hl === index ? "true" : undefined}
                    onMouseMove={() => setHl(index)}
                    onClick={() => openProject(project.rootDir)}
                  >
                    <span className="canvas-addproject-ic"><Folder size={14} aria-hidden /></span>
                    <span className="canvas-addproject-main">
                      <span className="canvas-addproject-name">{projectName(project)}</span>
                      <span className="canvas-addproject-sub canvas-addproject-mono">{project.rootDir}</span>
                    </span>
                    <span className="canvas-addproject-open">Open ↵</span>
                  </button>
                ))}
              </>
            ) : null}

            <div className="canvas-addproject-grp">Folders in {dirName}</div>
            {up ? (
              <button type="button" className="canvas-addproject-row" onClick={() => load(up)}>
                <span className="canvas-addproject-ic canvas-addproject-mono" aria-hidden>..</span>
                <span className="canvas-addproject-main">
                  <span className="canvas-addproject-name canvas-addproject-up">Parent folder</span>
                </span>
                <Kbd>←</Kbd>
              </button>
            ) : null}
            {entries.map((entry, i) => {
              const index = knownShown.length + i;
              return (
                <button
                  key={entry.path}
                  type="button"
                  data-row
                  className="canvas-addproject-row"
                  data-hl={hl === index ? "true" : undefined}
                  data-selected={selected === entry.path ? "true" : undefined}
                  aria-pressed={selected === entry.path}
                  onMouseMove={() => setHl(index)}
                  onClick={() => { setHl(index); setSelected(entry.path); }}
                  onDoubleClick={() => load(entry.path)}
                >
                  <span className="canvas-addproject-ic"><Folder size={14} aria-hidden /></span>
                  <span className="canvas-addproject-main">
                    <span className="canvas-addproject-name">
                      {entry.name}
                      {entry.isGitRepo ? <span className="canvas-addproject-badge">git</span> : null}
                    </span>
                  </span>
                  <Kbd>→</Kbd>
                </button>
              );
            })}
            {entries.length === 0 ? (
              <p className="canvas-addproject-empty">No subfolders here.</p>
            ) : null}
          </>
        )}
      </div>

      {/* A folder we could not read is not a folder we can open a project in. Offering it anyway is
          how an operator ends up with a project pointing at a machine that never answered. */}
      <div className="canvas-addproject-usebar">
        <span className="canvas-addproject-where" title={selected ?? path}>
          {selectedEntry ? <>Selected: <b>{selectedEntry.path}</b></> : <>Folder: <b>{path}</b></>}
        </span>
        <button
          type="button"
          className="canvas-addproject-ghost"
          disabled={!canUse}
          title={failure ? "This folder could not be read" : undefined}
          onClick={() => onUse(path)}
        >
          Use this folder ({dirName})
        </button>
        {selectedEntry && canUse ? (
          <button type="button" className="canvas-addproject-primary" onClick={() => onUse(selectedEntry.path)}>
            Use {selectedEntry.name} <Kbd>⌘↵</Kbd>
          </button>
        ) : null}
      </div>
      <Legend
        keys={[
          { k: "↵", label: "go in" },
          { k: "←", label: "up" },
          { k: "⌘↵", label: "use" },
          { k: "Esc", label: "back" },
        ]}
      />
    </div>
  );
}

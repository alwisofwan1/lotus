"use client";

import { ChevronLeft, ChevronRight, Folder, Search, Server } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { listSshHosts, machineAccessLogin, machineReadiness, type MachineReadiness } from "@/lib/tauri-api";
import { normalizeSshConfigHosts } from "@/modules/codespace/services/ssh-targets";
import { addMachineProject, browseMachine, listMachineProjects, retryRemoteChat, type ChatThread, type HostBrowse, type HostProject } from "../runtime/chat-runtime-client";

// Mockup: mockups/chat-remote-machine-browse.html. The folder pop has two levels: Places (this Mac's
// recent folders, then each SSH machine), and a folder browser inside one machine. The browser
// reads the machine's Lotus Host (`GET /api/fs`), so it shows only what that host lets anyone see.

export interface PickedMachine {
  host: string;
  user: string | null;
  port: number | null;
  workspaceId: string;
}

interface Row {
  alias: string;
  user: string | null;
  port: number | null;
  accessHostname: string | null;
}

function useMachineRows(): { rows: Row[]; readiness: Record<string, MachineReadiness> } {
  const [rows, setRows] = useState<Row[]>([]);
  const [readiness, setReadiness] = useState<Record<string, MachineReadiness>>({});
  useEffect(() => {
    let live = true;
    void listSshHosts()
      .then(async (hosts) => {
        const access = new Map(hosts.map((h) => [h.alias, h.accessHostname ?? null]));
        const found = normalizeSshConfigHosts(hosts)
          .filter((o) => o.capability === "shell")
          .map((o) => ({ alias: o.alias ?? o.host, user: o.user ?? null, port: o.port ?? null, accessHostname: access.get(o.alias ?? "") ?? null }));
        if (!live) return;
        setRows(found);
        const states = await Promise.all(found.map((r) => machineReadiness({ host: r.alias, ...(r.user ? { user: r.user } : {}), ...(r.port ? { port: r.port } : {}) }, r.accessHostname).catch(() => null)));
        if (live) setReadiness(Object.fromEntries(found.flatMap((r, i) => (states[i] ? [[r.alias, states[i]]] : []))));
      })
      .catch(() => {
        // No ~/.ssh/config is a normal state: the pop shows this Mac only.
      });
    return () => {
      live = false;
    };
  }, []);
  return { rows, readiness };
}

/** "/home/alwi/x" → "~/x". The host's home is not known here, so this is a guess for display only. */
export const shortPath = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+/, "~") || "/";

/** Above this many machines the list gets a filter field; below it, reading is faster than typing. */
const MANY_MACHINES = 6;

/**
 * The folder pop's body. `local` is this Mac's part (recent folders, "Choose folder…"); machines
 * follow it. Clicking a machine swaps the whole pop for that machine's folder browser.
 */
export function ChatFolderPlaces({ local, remote, onPick }: { local: ReactNode; remote: boolean; onPick: (machine: PickedMachine, project: HostProject) => void }) {
  const { rows, readiness } = useMachineRows();
  const [inside, setInside] = useState<Row | null>(null);
  const [find, setFind] = useState("");
  // Machines with SSH already open first: they answer at once, and they are the ones in use.
  const shown = rows
    .filter((r) => r.alias.toLowerCase().includes(find.toLowerCase()))
    .sort((a, b) => Number(!!readiness[b.alias]?.connected) - Number(!!readiness[a.alias]?.connected));
  if (inside) return <MachineBrowser row={inside} ready={readiness[inside.alias]} onBack={() => setInside(null)} onPick={onPick} />;
  return (
    <>
      {local}
      {remote && rows.length > 0 && (
        <>
          <hr className="chat-perm-sep" />
          <p className="chat-machine-name">Machines</p>
          {rows.length > MANY_MACHINES && (
            <label className="chat-browse-filter">
              <Search size={12} aria-hidden />
              <input value={find} placeholder="Filter machines" aria-label="Filter machines" onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => {
                  if (e.key === "Enter" && shown[0]) setInside(shown[0]);
                }} />
            </label>
          )}
          {shown.length === 0 && <p className="chat-machine-note">No machine matches “{find}”.</p>}
          {shown.map((row) => (
            <button key={row.alias} type="button" className="chat-folder-add chat-machine-row" onClick={() => setInside(row)}>
              <Server size={13} aria-hidden />
              <span>{row.alias}</span>
              <span className="chat-machine-dot" data-on={readiness[row.alias]?.connected || undefined} title={readiness[row.alias]?.connected ? "SSH open" : undefined} />
              <ChevronRight className="chat-machine-chev" size={13} aria-hidden />
            </button>
          ))}
        </>
      )}
    </>
  );
}

/** The breadcrumb for `path`: it starts at the root holding it, since the host shows nothing above. */
export function crumbsOf(roots: HostBrowse["roots"], path: string): { name: string; path: string }[] {
  const root = roots.find((r) => path === r.path || path.startsWith(`${r.path}/`));
  if (!root) return [];
  const rest = path.slice(root.path.length).split("/").filter(Boolean);
  return [root, ...rest.map((name, i) => ({ name, path: `${root.path}/${rest.slice(0, i + 1).join("/")}` }))];
}

type Load =
  | { state: "loading" }
  | { state: "ready"; data: HostBrowse }
  | { state: "failed"; reason: string }
  | { state: "sign-in"; hostname: string; waiting: boolean };

/** The browser sign-in is polled this often, for at most this long, before the button comes back. */
const SIGN_IN_POLL_MS = 1500;
const SIGN_IN_WAIT_MS = 5 * 60_000;

/** The Access application to sign in to, when an expired token is what stands between us and the host. */
export const needsLogin = (ready: MachineReadiness | null | undefined) =>
  ready && !ready.connected && ready.access?.state === "needs-login" ? ready.access.hostname : null;

/**
 * Open the Access sign-in, then wait for its token. `access login` returns once its URL is printed,
 * not once the browser is done, so "returned" is not "signed in". True once the token exists.
 */
async function signInAndWait(hostname: string, check: () => Promise<MachineReadiness | null>, alive: () => boolean): Promise<boolean> {
  await machineAccessLogin(hostname).catch(() => null);
  for (const until = Date.now() + SIGN_IN_WAIT_MS; alive() && Date.now() < until; ) {
    await new Promise((done) => setTimeout(done, SIGN_IN_POLL_MS));
    const now = await check();
    if (now?.connected || now?.access?.state === "signed-in") return alive();
  }
  return false;
}

function MachineBrowser({ row, ready, onBack, onPick }: { row: Row; ready: MachineReadiness | undefined; onBack: () => void; onPick: (machine: PickedMachine, project: HostProject) => void }) {
  const target = { host: row.alias, user: row.user, port: row.port };
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState(0);
  const [picking, setPicking] = useState<string | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const alive = useRef(true);

  // Asked fresh each time: the pop's snapshot is stale once a sign-in has happened.
  const readinessNow = (): Promise<MachineReadiness | null> =>
    row.accessHostname
      ? machineReadiness({ host: row.alias, ...(row.user ? { user: row.user } : {}), ...(row.port ? { port: row.port } : {}) }, row.accessHostname).catch(() => null)
      : Promise.resolve(null);

  // Sets state only once the host answers, so the first load can run from an effect.
  const fetchPage = (path: string | null): Promise<void> =>
    browseMachine(target, path).then(
      // One root (the usual host) is entered at once: a list with one choice is a wasted step.
      (data) => (path === null && data.roots.length === 1 ? fetchPage(data.roots[0].path) : setLoad({ state: "ready", data })),
      (reason: unknown) =>
        readinessNow().then((now) => {
          const hostname = needsLogin(now);
          setLoad(hostname ? { state: "sign-in", hostname, waiting: false } : { state: "failed", reason: String(reason) });
        }),
    );
  const go = (path: string | null) => {
    setLoad({ state: "loading" });
    setQuery("");
    setFocus(0);
    setPickError(null);
    void fetchPage(path);
  };
  // An expired Access token is caught BEFORE ssh: ssh would hang its 35 s budget, and killing it then
  // kills the cloudflared whose browser tab the operator signs in on, so that sign-in lands no token.
  useEffect(() => {
    alive.current = true;
    void (ready?.access || ready?.connected ? Promise.resolve(ready) : readinessNow()).then((now) => {
      if (!alive.current) return;
      const hostname = needsLogin(now);
      if (hostname) setLoad({ state: "sign-in", hostname, waiting: false });
      else void fetchPage(null);
    });
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per machine
  }, [row.alias]);

  const signIn = async (hostname: string) => {
    setLoad({ state: "sign-in", hostname, waiting: true });
    if (await signInAndWait(hostname, readinessNow, () => alive.current)) go(null);
    else if (alive.current) setLoad({ state: "sign-in", hostname, waiting: false });
  };

  const page = load.state === "ready" ? load.data.page : null;
  const roots = load.state === "ready" ? load.data.roots : [];
  const typed = query.startsWith("/");
  const items = page
    ? page.entries.filter((e) => e.name.toLowerCase().includes(query.toLowerCase()))
    : roots.map((r) => ({ ...r, isRepo: false, isProject: false })).filter((e) => e.name.toLowerCase().includes(query.toLowerCase()));

  const pickFolder = async (path: string) => {
    setPicking(path);
    setPickError(null);
    try {
      // A folder the host already holds keeps its project; any other becomes one.
      const held = (await listMachineProjects(target)).find((p) => p.path === path);
      const project = held ?? (await addMachineProject(target, path));
      onPick({ ...target, workspaceId: project.id }, project);
    } catch (reason) {
      setPickError(String(reason).replace(/^Error: /, ""));
    } finally {
      setPicking(null);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const pick = items[focus];
    if (event.key === "ArrowDown") setFocus(Math.min(focus + 1, items.length - 1));
    else if (event.key === "ArrowUp") setFocus(Math.max(focus - 1, 0));
    else if (event.key === "ArrowRight" && pick && !typed) go(pick.path);
    else if (event.key === "ArrowLeft" && !query && page) go(page.parent);
    else if (event.key === "Enter" && typed) go(query.replace(/\/+$/, "") || "/");
    else if (event.key === "Enter" && page) void pickFolder(page.path);
    else return;
    event.preventDefault();
  };

  const crumbs = page ? crumbsOf(roots, page.path) : [];

  return (
    <div className="chat-browse" role="group" aria-label={`Folders on ${row.alias}`}>
      <div className="chat-browse-top">
        <button type="button" className="chat-browse-back" aria-label="Back to places" onClick={onBack}>
          <ChevronLeft size={14} aria-hidden />
        </button>
        <nav className="chat-browse-crumbs" aria-label="Path">
          <span className="chat-browse-machine">{row.alias}</span>
          {roots.length > 1 && <button type="button" onClick={() => go(null)}>all</button>}
          {crumbs.map((c) => (
            <Fragment key={c.path}>
              <ChevronRight size={11} aria-hidden />
              <button type="button" aria-current={c.path === page?.path ? "location" : undefined} onClick={() => go(c.path)}>{c.name}</button>
            </Fragment>
          ))}
        </nav>
      </div>
      <label className="chat-browse-filter">
        <Search size={12} aria-hidden />
        <input autoFocus value={query} placeholder="Filter, or type a /path" aria-label="Filter folders, or type a path" onChange={(e) => {
            setQuery(e.target.value);
            setFocus(0);
          }} onKeyDown={onKey} />
      </label>
      <div className="chat-browse-list" role="listbox" aria-label="Folders">
        {load.state === "loading" && <p className="chat-machine-note">Loading folders…</p>}
        {load.state === "sign-in" && (load.waiting ? (
          // A closed tab is reopened by the same call: the waiting login is reused, not doubled.
          <button type="button" className="chat-machine-note" aria-live="polite" title="Open the sign-in tab again" onClick={() => void machineAccessLogin(load.hostname).catch(() => null)}>
            Finish the Cloudflare sign-in in your browser… Open again
          </button>
        ) : (
          <button type="button" className="chat-machine-note" data-tone="warn" onClick={() => void signIn(load.hostname)}>
            Cloudflare sign-in expired. Sign in…
          </button>
        ))}
        {load.state === "failed" && (
          <button type="button" className="chat-machine-note" data-tone="warn" title={load.reason} onClick={() => go(page?.path ?? null)}>
            No Lotus Host answered on {row.alias}. Try again
          </button>
        )}
        {load.state === "ready" && typed && (
          <button type="button" className="chat-browse-row" data-focus onClick={() => go(query.replace(/\/+$/, "") || "/")}>
            <Folder size={13} aria-hidden />
            <span className="chat-browse-name">Go to {query}</span>
          </button>
        )}
        {load.state === "ready" && !typed && items.length === 0 && <p className="chat-machine-note">{query ? `No folder here matches “${query}”.` : "No folders here."}</p>}
        {load.state === "ready" && !typed && items.map((entry, i) => (
          <div key={entry.path} className="chat-browse-row" role="option" aria-selected={i === focus} data-focus={i === focus || undefined} onMouseEnter={() => setFocus(i)} onClick={() => go(entry.path)}>
            <Folder size={13} aria-hidden />
            <span className="chat-browse-name">{entry.name}</span>
            <span className="chat-browse-tags">
              {entry.isRepo && <span className="chat-browse-tag">git</span>}
              {entry.isProject && <span className="chat-browse-tag" data-tone="project">project</span>}
            </span>
            <button type="button" className="chat-browse-use" disabled={picking !== null} onClick={(e) => {
                e.stopPropagation();
                void pickFolder(entry.path);
              }}>
              Use
            </button>
          </div>
        ))}
      </div>
      <div className="chat-browse-foot">
        {pickError ? <span className="chat-browse-error" title={pickError}>{pickError}</span> : <span className="chat-browse-keys"><kbd>→</kbd> in <kbd>←</kbd> up <kbd>↵</kbd> use</span>}
        <button type="button" className="chat-browse-primary" disabled={!page || picking !== null} title={page?.path} onClick={() => page && void pickFolder(page.path)}>
          {picking ? "Opening…" : page ? `Use ${shortPath(page.path)}` : "Use"}
        </button>
      </div>
    </div>
  );
}

/** How long a drop may last before "Reconnecting" shows: a Wi-Fi blip or a wake heals unseen. */
const RECONNECT_QUIET_MS = 3000;

/**
 * One line above the composer while a remote chat's machine cannot be reached (decisions 5–7).
 * "down" asks whether a lapsed Cloudflare sign-in is the cause, and offers that sign-in instead.
 */
export function ChatRemoteNotice({ thread, onError }: { thread: Pick<ChatThread, "id" | "machine" | "link">; onError: (reason: unknown) => void }) {
  const { id, machine, link } = thread;
  const host = machine?.host ?? "";
  const user = machine?.user ?? null;
  const port = machine?.port ?? null;
  // Mounted again per link state (the caller keys it), so nothing here needs resetting.
  const [shown, setShown] = useState(link === "down");
  const [access, setAccess] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (link !== "reconnecting") return;
    const timer = setTimeout(() => setShown(true), RECONNECT_QUIET_MS);
    return () => clearTimeout(timer);
  }, [link]);

  // Only when down, and once per drop: is this a Cloudflare host whose sign-in has lapsed?
  useEffect(() => {
    if (link !== "down" || !host) return;
    let live = true;
    void listSshHosts()
      .then(async (hosts) => {
        const name = hosts.find((h) => h.alias === host)?.accessHostname;
        if (!name) return;
        const ready = await machineReadiness({ host, ...(user ? { user } : {}), ...(port ? { port } : {}) }, name);
        if (live && ready.access?.state === "needs-login" && !ready.connected) setAccess(ready.access.hostname);
      })
      .catch(() => {
        // Unknown cause: the plain "not answering" line with Retry is still right.
      });
    return () => {
      live = false;
    };
  }, [link, host, user, port]);

  if (!machine || !link || !shown) return null;
  const retry = () => void retryRemoteChat(id).catch(onError);
  if (link === "reconnecting") {
    return (
      <div className="chat-handoff-bar chat-remote-note" role="status">
        <span className="chat-remote-spin" aria-hidden />
        <span className="chat-handoff-bar-text">Reconnecting to {host}…</span>
      </div>
    );
  }
  // Signed in → reconnect at once, instead of asking the operator to press Retry as well.
  const signIn = async (hostname: string) => {
    setWaiting(true);
    const check = () => machineReadiness({ host, ...(user ? { user } : {}), ...(port ? { port } : {}) }, hostname).catch(() => null);
    const ok = await signInAndWait(hostname, check, () => alive.current);
    if (!alive.current) return;
    setWaiting(false);
    if (ok) {
      setSignedIn(true);
      retry();
    }
  };
  if (access && !signedIn) {
    return (
      <div className="chat-handoff-bar chat-remote-note" data-tone="warn" role="alert">
        <span className="chat-handoff-bar-text">{waiting ? "Finish the Cloudflare sign-in in your browser…" : `Cloudflare sign-in for ${host} expired.`}</span>
        {waiting ? (
          <button type="button" className="chat-model-manage" onClick={() => void machineAccessLogin(access).catch(() => null)}>
            Open again
          </button>
        ) : (
          <button type="button" className="chat-model-manage" onClick={() => void signIn(access)}>
            Sign in
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="chat-handoff-bar chat-remote-note" data-tone="danger" role="alert">
      <span className="chat-handoff-bar-text">{signedIn ? `Signed in? Reconnect to ${host}.` : `${host}’s Lotus Host is not answering.`}</span>
      <button type="button" className="chat-model-manage" onClick={retry}>
        Retry
      </button>
    </div>
  );
}

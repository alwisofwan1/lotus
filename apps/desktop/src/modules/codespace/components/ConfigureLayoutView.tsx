"use client";
import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { FolderOpen, ChevronLeft, ChevronDown, GitBranch, Package, Loader2, Monitor, Server, AlertTriangle, X, Pencil } from "lucide-react";
import { getHomedir, listDirEntries, getSettings, saveSettings, isTauri, detectInstalledClis } from "@/lib/tauri-api";
import { sshProbeWorkspace } from "@/lib/tauri/codespace-editor-ssh";
import {
  getFleetAgentDefinitions,
  buildAgentCommands,
  deriveSavedTerminalCommandName,
  ensureUniqueSavedTerminalCommandName,
  getSavedTerminalCommandsFromSettings,
  mergeSavedTerminalCommandsIntoSettings,
  type FleetAgentDefinition,
  type SavedTerminalCommand,
} from "@/modules/codespace/services/terminal-fleet";
import { CliLogo } from "@/modules/lotus-settings/components/CliLogo";
import { cn } from "@/lib/utils";
import { AGENT_TYPES, LAYOUT_TEMPLATES } from "./constants";
import type { LayoutTemplate, Preset, PresetRemote } from "./types";
import { validatePreset } from "./types";
import { MiniGrid, PresetPalette, leafName, presetOrder, templateOf } from "./PresetPalette";
import { useFormatShortcut } from "@/lib/hooks/useShortcutLabel";

interface DirEntry { name: string; path: string; isGitRepo: boolean; hasPackageJson: boolean; }

interface ConfigureLayoutViewProps {
  onCancel: () => void;
  /**
   * Asks for a folder on another machine (SSH): resolves with it, or null when the picker was
   * closed. Absent where only local folders make sense.
   */
  onPickRemote?: () => Promise<{ remote: PresetRemote; cwd: string } | null>;
  /** One command per pane ("" = plain shell). `remote` absent = this Mac. */
  onLaunch: (template: LayoutTemplate, cwd: string, agentCommands: string[], workspaceLabel?: string, remote?: PresetRemote) => void;
}

export const isTextField = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.matches("input, textarea, select") || t.isContentEditable);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const trimSlash = (p: string) => p.replace(/\/+$/, "") || "/";

/** The shapes always on show; the rest sit behind "more". */
const COMMON_SESSIONS = new Set([1, 2, 4, 6, 8]);

// shortcut: mirrors the binaries `cli_detect.rs` KNOWN_CLIS asks a machine about, whose names equal the
// chip's command. Upgrade when the probe reports which runners it asked about.
const PROBED_EXECUTABLES = new Set(["claude", "codex", "gemini", "opencode", "cursor-agent", "droid", "copilot", "agy", "grok", "kimi", "pi"]);

/** The last layout and agents launched, so the next New workspace opens ready for ⌘↵. Per device. */
const LAST_KEY = "lotus.new-workspace.last";
function readLast(): { templateId: string; agentSlots: Record<string, number> } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null");
    return raw && typeof raw.templateId === "string" && raw.agentSlots && typeof raw.agentSlots === "object" ? raw : null;
  } catch { return null; }
}

const remoteKey = (r: PresetRemote) => `${r.user ?? ""}@${r.host}:${r.port ?? ""}`;

function createCommandId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return `custom:${slug || crypto.randomUUID()}`;
}

/**
 * The agent in each pane, in launch order. Mirrors `buildAgentCommands`: slots are counts, filled
 * top-down in the order the agents were first added — a pane has no agent of its own (decision A,
 * 2026-11-20), so the preview must not pretend otherwise.
 */
function paneAgents(slots: Record<string, number>, definitions: FleetAgentDefinition[], total: number): FleetAgentDefinition[] {
  const byId = new Map(definitions.map(d => [d.id, d]));
  return Object.entries(slots)
    .flatMap(([id, n]) => {
      const d = byId.get(id);
      return d && d.command.trim() && n > 0 ? Array<FleetAgentDefinition>(n).fill(d) : [];
    })
    .slice(0, total);
}

/** Drops agents from the end until they fit `total` panes. */
function fitSlots(slots: Record<string, number>, total: number): Record<string, number> {
  const next = { ...slots };
  let over = Object.values(next).reduce((s, n) => s + Math.max(0, n), 0) - total;
  for (const id of Object.keys(next).reverse()) {
    if (over <= 0) break;
    const cut = Math.min(next[id], over);
    next[id] -= cut;
    over -= cut;
  }
  return next;
}

function AgentIcon({ agent, size }: { agent: FleetAgentDefinition; size: number }) {
  return agent.isCustom || !AGENT_TYPES.some(e => e.id === agent.id)
    ? <span className="cl-agent-ico is-custom">{">_"}</span>
    : <span className="cl-agent-ico"><CliLogo id={agent.id} size={size} brand /></span>;
}

// ── Inline autocomplete directory picker ─────────────────────────────────────
function DirAutocomplete({ value, onChange, leading, trailing }: {
  value: string;
  onChange: (p: string) => void;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const [inputValue, setInputValue] = useState(value);
  const [browsePath, setBrowsePath] = useState(value);
  const [allEntries, setAllEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setInputValue(value); setBrowsePath(value); }, [value]);

  // Clear pending debounce timer on unmount to avoid setState on unmounted component
  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  const fetchEntries = useCallback((path: string) => {
    const target = path || "/";
    setLoading(true);
    setFetchError(null);
    listDirEntries(target)
      .then((data: DirEntry[]) => { setAllEntries(data); setLoading(false); })
      .catch((err: unknown) => {
        setFetchError(err instanceof Error ? err.message : "Failed to read directory");
        setAllEntries([]);
        setLoading(false);
      });
  }, []);

  useEffect(() => { if (open) fetchEntries(browsePath || "/"); }, [browsePath, open, fetchEntries]);

  const lastSlash = inputValue.lastIndexOf("/");
  const filterSegment = lastSlash >= 0 ? inputValue.slice(lastSlash + 1).toLowerCase() : inputValue.toLowerCase();
  const visible = filterSegment ? allEntries.filter(e => e.name.toLowerCase().startsWith(filterSegment)) : allEntries;

  const handleInputChange = (raw: string) => {
    setInputValue(raw);
    setHighlighted(-1);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const idx = raw.lastIndexOf("/");
      setBrowsePath(idx > 0 ? raw.slice(0, idx) : "/");
    }, 180);
  };

  const commitSelectedPath = useCallback((path: string) => {
    setInputValue(path);
    setBrowsePath(path);
    setHighlighted(-1);
    setAllEntries([]);
    setFetchError(null);
    setOpen(false);
    onChange(path);
  }, [onChange]);

  const selectEntry = (entry: DirEntry) => {
    if (entry.isGitRepo || entry.hasPackageJson) {
      commitSelectedPath(entry.path);
      return;
    }

    setInputValue(entry.path);
    setBrowsePath(entry.path);
    onChange(entry.path);
    setHighlighted(-1);
    fetchEntries(entry.path);
    inputRef.current?.focus();
  };

  const openInlineBrowser = useCallback(() => {
    setOpen(true);
    fetchEntries(browsePath || inputValue || "/");
    inputRef.current?.focus();
  }, [browsePath, fetchEntries, inputValue]);

  const handleBrowse = useCallback(async () => {
    if (pickingDirectory) return;

    if (!isTauri()) {
      openInlineBrowser();
      return;
    }

    setPickingDirectory(true);
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const selected = await openDialog({
        directory: true,
        multiple: false,
        defaultPath: browsePath || inputValue || undefined,
      });

      if (typeof selected !== "string" || !selected.trim()) {
        return;
      }

      commitSelectedPath(selected.trim());
    } catch (error) {
      setFetchError(error instanceof Error ? error.message : "Failed to open directory picker");
      openInlineBrowser();
    } finally {
      setPickingDirectory(false);
    }
  }, [browsePath, commitSelectedPath, inputValue, openInlineBrowser, pickingDirectory]);

  const goUp = () => {
    const parent = browsePath.split("/").slice(0, -1).join("/") || "/";
    setBrowsePath(parent);
    setInputValue(parent);
    onChange(parent);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) { setOpen(true); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlighted(h => Math.min(h + 1, visible.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlighted(h => Math.max(h - 1, -1)); }
    else if (e.key === "Enter") {
      if (e.metaKey || e.ctrlKey) return; // ⌘↵ belongs to Launch
      e.preventDefault();
      if (highlighted >= 0 && visible[highlighted]) selectEntry(visible[highlighted]);
      else { onChange(inputValue); setOpen(false); }
    } else if (e.key === "Escape") setOpen(false);
    else if (e.key === "Tab" && visible[0]) {
      e.preventDefault();
      setInputValue(visible[0].path + "/");
      setBrowsePath(visible[0].path);
      onChange(visible[0].path);
      fetchEntries(visible[0].path);
    }
  };

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  return (
    <div ref={containerRef} className="cl-dir">
      <div className={cn("cl-field", leading != null && "has-lead")}>
        {leading ?? <FolderOpen size={16} />}
        <input
          ref={inputRef}
          className="cl-mono"
          value={inputValue}
          onChange={e => handleInputChange(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          autoComplete="off" spellCheck={false}
          placeholder="/Users/you/projects"
          aria-label="Project folder"
        />
        {loading ? <Loader2 size={14} className="animate-spin" /> : trailing}
        <button
          type="button"
          className="cl-chip-btn"
          onMouseDown={e => e.preventDefault()}
          onClick={handleBrowse}
          disabled={pickingDirectory}
        >
          {pickingDirectory ? "Opening…" : "Browse…"}
        </button>
      </div>

      {open && (
        <div className="cl-pop">
          <div className="cl-pop-head">
            <button type="button" className="cl-icon-btn" aria-label="Parent folder"
              onMouseDown={e => { e.preventDefault(); goUp(); }}>
              <ChevronLeft size={14} />
            </button>
            <span className="cl-mono">{browsePath || "/"}</span>
          </div>
          <div className="cl-pop-list">
            {fetchError && !loading && <p className="cl-pop-msg is-error">{fetchError}</p>}
            {visible.length === 0 && !loading && !fetchError && <p className="cl-pop-msg">No matching directories</p>}
            {visible.map((entry, idx) => (
              <div key={entry.path} onMouseDown={e => { e.preventDefault(); selectEntry(entry); }}
                className={cn("cl-pop-item", highlighted === idx && "is-hl")}>
                <FolderOpen size={16} />
                <span>{entry.name}</span>
                {entry.isGitRepo && <span className="cl-tag"><GitBranch size={11} />git</span>}
                {entry.hasPackageJson && <span className="cl-tag"><Package size={11} />npm</span>}
              </div>
            ))}
          </div>
          <div className="cl-pop-foot">
            {["↑↓ navigate", "↵ select", "Tab complete", "Esc close"].map(h => <span key={h}>{h}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}

// ── What the chosen folder is: the same signal the dropdown computes ──
function DirFacts({ cwd }: { cwd: string }) {
  const path = cwd.replace(/\/+$/, "");
  const [found, setFound] = useState<{ path: string; entry: DirEntry | null } | null>(null);
  const entry = found?.path === path ? found.entry : null;
  useEffect(() => {
    let live = true;
    if (!path) return;
    const parent = path.slice(0, path.lastIndexOf("/")) || "/";
    listDirEntries(parent)
      .then((data: DirEntry[]) => { if (live) setFound({ path, entry: data.find(e => e.path.replace(/\/+$/, "") === path) ?? null }); })
      .catch(() => {});
    return () => { live = false; };
  }, [path]);
  if (!entry?.isGitRepo && !entry?.hasPackageJson) return null;
  return (
    <span className="cl-facts">
      {entry.isGitRepo && <span className="cl-tag is-ok"><GitBranch size={11} />git</span>}
      {entry.hasPackageJson && <span className="cl-tag"><Package size={11} />package.json</span>}
    </span>
  );
}
// ─────────────────────────────────────────────────────────────────────────────

const PRESETS_KEY = "terminal-presets";
const VALID_TEMPLATE_IDS = new Set(LAYOUT_TEMPLATES.map(t => t.id));

async function loadPresetsFromStorage(): Promise<Preset[]> {
  try {
    const settings = await getSettings();
    const raw = settings[PRESETS_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.map(r => validatePreset(r, VALID_TEMPLATE_IDS)).filter((p): p is Preset => p !== null);
  } catch {
    // Fallback to localStorage (non-Tauri / dev mode)
    try {
      const saved = localStorage.getItem(PRESETS_KEY);
      if (!saved) return [];
      const raw = JSON.parse(saved);
      if (!Array.isArray(raw)) return [];
      return raw.map((r: unknown) => validatePreset(r, VALID_TEMPLATE_IDS)).filter((p): p is Preset => p !== null);
    } catch { return []; }
  }
}

async function persistPresets(presets: Preset[]): Promise<void> {
  try {
    const settings = await getSettings();
    settings[PRESETS_KEY] = presets;
    await saveSettings(settings);
  } catch {
    // Fallback to localStorage
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
  }
}

/** A saved preset ready to launch from outside this page (Code mode's empty state). */
export interface LaunchablePreset {
  preset: Preset;
  template: LayoutTemplate;
  agentCommands: string[];
}

/** Saved presets in "Jump back in" order, each with the agent commands `launchPreset` would use. */
export async function loadLaunchablePresets(): Promise<LaunchablePreset[]> {
  const [presets, settings] = await Promise.all([loadPresetsFromStorage(), getSettings().catch(() => ({}))]);
  const saved = getSavedTerminalCommandsFromSettings(settings);
  return presetOrder(presets).map((preset) => ({
    preset,
    template: templateOf(preset),
    agentCommands: buildAgentCommands(preset.agentSlots ?? {}, getFleetAgentDefinitions(saved, preset), templateOf(preset).sessions),
  }));
}

/** Stamps `lastOpenedAt`, as `launchPreset` does, so the order stays "most recent first". */
export async function markPresetOpened(id: string): Promise<void> {
  const presets = await loadPresetsFromStorage();
  await persistPresets(presets.map(p => p.id === id ? { ...p, lastOpenedAt: Date.now() } : p));
}

/**
 * "New workspace": folder, panes and agents on one screen (`mockups/workspace-create-revamp.html`).
 * Saved presets show as a "Jump back in" row; the rest live in {@link PresetPalette} (⌘P).
 */
export function ConfigureLayoutView({ onCancel, onPickRemote, onLaunch }: ConfigureLayoutViewProps) {
  const [cwd, setCwd] = useState("");
  const shortcut = useFormatShortcut();
  const [remote, setRemote] = useState<PresetRemote | null>(null);
  const [homedir, setHomedir] = useState("");
  const [selected, setSelected] = useState<LayoutTemplate>(LAYOUT_TEMPLATES[0]);
  const [slots, setSlots] = useState<Record<string, number>>({});
  const [presets, setPresets] = useState<Preset[]>([]);
  const [savedCommands, setSavedCommands] = useState<SavedTerminalCommand[]>([]);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [saveAsPreset, setSaveAsPreset] = useState(false);
  const [newPresetName, setNewPresetName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [undo, setUndo] = useState<{ name: string; restore: () => void } | null>(null);
  const [newCommand, setNewCommand] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const presetNameRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [agentsMoreOpen, setAgentsMoreOpen] = useState(false);
  // Agent CLIs installed on this Mac, by id; null when unknown (outside the app, or an older binary).
  const [localClis, setLocalClis] = useState<Set<string> | null>(null);
  // What the remote machine answered: reachable, and which agent CLIs it has. Keyed, so an answer for
  // a machine you have since left is ignored, and "not asked yet" reads as checking.
  const [probe, setProbe] = useState<{ key: string; ok: boolean; runners: Set<string> | null } | null>(null);

  // Draw once everything the first screen depends on has answered. Drawn piecemeal, "Jump back in"
  // arrived after the form and pushed it down, and the folder filled in after an empty field.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    const last = readLast();
    const lastTemplate = last && LAYOUT_TEMPLATES.find(t => t.id === last.templateId);
    if (lastTemplate) { setSelected(lastTemplate); setSlots(fitSlots({ ...last.agentSlots }, lastTemplate.sessions)); }
    const clis = detectInstalledClis().then((list) => {
      if (live && list.length > 0) setLocalClis(new Set(list.filter(c => c.installed).map(c => c.id)));
    });
    void Promise.allSettled([
      // Bounded: a slow detection must not hold the page; it then reorders the chips once, late.
      Promise.race([clis, new Promise(r => setTimeout(r, 800))]),
      getHomedir().then((home) => { if (live && home) { setHomedir(home); setCwd(c => c || home); } }),
      loadPresetsFromStorage().then((p) => { if (live) setPresets(p); }),
      getSettings().then((settings) => { if (live) setSavedCommands(getSavedTerminalCommandsFromSettings(settings)); }),
    ]).then(() => { if (live) setReady(true); });
    return () => { live = false; };
  }, []);

  const remoteHost = remote?.host;
  const remoteUser = remote?.user;
  const remotePort = remote?.port;
  useEffect(() => {
    if (!remoteHost) return;
    const target = { host: remoteHost, user: remoteUser ?? null, port: remotePort ?? null };
    const key = remoteKey({ kind: "ssh", host: remoteHost, user: remoteUser, port: remotePort });
    let live = true;
    sshProbeWorkspace(target)
      .then((profile) => { if (live) setProbe({ key, ok: true, runners: profile.runners ? new Set(profile.runners.map(r => r.id)) : null }); })
      .catch(() => { if (live) setProbe({ key, ok: false, runners: null }); });
    return () => { live = false; };
  }, [remoteHost, remoteUser, remotePort]);
  const machine = remote && probe?.key === remoteKey(remote) ? probe : null;
  const machineState = !remote ? null : !machine ? "checking" : machine.ok ? "connected" : "unreachable";
  /** Known to be absent on the machine the panes run on. Unasked or unjudged never counts as missing. */
  const missingOnMachine = (d: FleetAgentDefinition) => {
    if (d.isCustom) return false;
    if (!remote) return !!localClis && AGENT_TYPES.some(a => a.id === d.id) && !localClis.has(d.id);
    const exe = d.command.trim().split(/\s+/)[0] ?? "";
    return !!machine?.runners && PROBED_EXECUTABLES.has(exe) && !machine.runners.has(exe);
  };
  // Local detection has missed real installs (agy in ~/.local/bin), so on this Mac it only warns;
  // the VPS answer comes from asking that machine directly, so there it disables (decision A).
  const missingNote = remote ? `not on ${remote.host}` : "not installed";

  const loaded = presets.find(p => p.id === loadedId) ?? null;
  const definitions = getFleetAgentDefinitions(savedCommands, loaded ?? undefined);
  const total = selected.sessions;
  const assigned = paneAgents(slots, definitions, total);
  const free = total - assigned.length;
  const counts = new Map<string, number>();
  for (const a of assigned) counts.set(a.id, (counts.get(a.id) ?? 0) + 1);
  // Picked agents first, in pick order, so the "on" chips stay together and the rest read as a menu.
  // Agents the machine lacks wait behind "+ N more", unless one is already picked.
  const allChips = [...definitions.filter(d => counts.has(d.id)), ...definitions.filter(d => !counts.has(d.id))];
  const hiddenChips = allChips.filter(d => !counts.has(d.id) && missingOnMachine(d));
  const chips = agentsMoreOpen ? allChips : allChips.filter(d => !hiddenChips.includes(d));
  const pickedCount = counts.size;
  const atHome = !remote && !!homedir && trimSlash(cwd) === trimSlash(homedir);
  const ordered = presetOrder(presets);

  const savePresets = (next: Preset[]) => { setPresets(next); void persistPresets(next); };

  const chooseTemplate = (t: LayoutTemplate) => {
    setSelected(t);
    setSlots(s => fitSlots(s, t.sessions));
  };

  const addAgent = (id: string, fillAll = false) => {
    if (free <= 0) return;
    setSlots(s => ({ ...s, [id]: (s[id] ?? 0) + (fillAll ? free : 1) }));
  };
  const removeAgent = (id: string) => setSlots(s => ({ ...s, [id]: Math.max(0, (s[id] ?? 0) - 1) }));

  const loadPreset = (p: Preset) => {
    setLoadedId(p.id);
    setSelected(templateOf(p));
    setCwd(p.cwd);
    setRemote(p.location ?? null);
    setSlots(fitSlots({ ...p.agentSlots }, templateOf(p).sessions));
    setSaveAsPreset(false);
    setNameError(null);
    setPaletteOpen(false);
  };

  const startFresh = () => {
    setLoadedId(null);
    setSlots({});
    setSelected(LAYOUT_TEMPLATES[0]);
    setRemote(null);
    if (homedir) setCwd(homedir);
  };

  const pickRemote = async () => {
    const picked = await onPickRemote?.();
    if (!picked) return;
    setRemote(picked.remote);
    setCwd(picked.cwd);
  };

  const backToMac = () => {
    setRemote(null);
    setCwd(homedir);
  };

  const commandsFor = (p: Preset) => {
    const defs = getFleetAgentDefinitions(savedCommands, p);
    return buildAgentCommands(p.agentSlots ?? {}, defs, templateOf(p).sessions);
  };

  const agentNames = useCallback((p: Preset) => {
    const defs = getFleetAgentDefinitions(savedCommands, p);
    return Object.entries(p.agentSlots).filter(([, v]) => v > 0).map(([id]) => defs.find(d => d.id === id)?.name ?? id);
  }, [savedCommands]);

  const launchPreset = (p: Preset) => {
    savePresets(presets.map(x => x.id === p.id ? { ...x, lastOpenedAt: Date.now() } : x));
    onLaunch(templateOf(p), p.cwd, commandsFor(p), p.name, p.location);
  };

  const launch = () => {
    const now = Date.now();
    const custom = definitions.filter(d => d.isCustom);
    const agentConfig = {
      agentSlots: Object.fromEntries(Object.entries(slots).filter(([, n]) => n > 0)),
      customCommands: Object.fromEntries(custom.map(d => [d.id, d.command])),
      customCommandNames: Object.fromEntries(custom.map(d => [d.id, d.name])),
      location: remote ?? undefined,
    };
    let label: string | undefined;
    if (saveAsPreset) {
      const name = newPresetName.trim();
      if (!name) { setNameError("Name the preset, or untick Save as preset"); presetNameRef.current?.focus(); return; }
      if (presets.some(p => p.name.toLowerCase() === name.toLowerCase())) {
        setNameError("A preset with this name already exists");
        presetNameRef.current?.focus();
        return;
      }
      savePresets([...presets, { id: crypto.randomUUID(), name, templateId: selected.id, cwd, ...agentConfig, lastOpenedAt: now, createdAt: now, updatedAt: now }]);
      label = name;
    } else if (loaded) {
      savePresets(presets.map(p => p.id === loaded.id ? { ...p, templateId: selected.id, cwd, ...agentConfig, lastOpenedAt: now, updatedAt: now } : p));
      label = loaded.name;
    }
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ templateId: selected.id, agentSlots: agentConfig.agentSlots })); } catch { /* a convenience only */ }
    onLaunch(selected, cwd, buildAgentCommands(slots, definitions, total), label, remote ?? undefined);
  };

  const renamePreset = (id: string, newName: string) => {
    const name = newName.trim();
    if (!name || presets.some(p => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) return;
    savePresets(presets.map(p => p.id === id ? { ...p, name, updatedAt: Date.now() } : p));
  };

  const deletePreset = (id: string) => {
    const index = presets.findIndex(p => p.id === id);
    if (index < 0) return;
    const gone = presets[index];
    const next = presets.filter(p => p.id !== id);
    savePresets(next);
    if (loadedId === id) setLoadedId(null);
    setUndo({
      name: gone.name,
      restore: () => {
        setPresets(cur => {
          const back = [...cur.slice(0, index), gone, ...cur.slice(index)];
          void persistPresets(back);
          return back;
        });
        setUndo(null);
      },
    });
  };

  const togglePin = (id: string) => savePresets(presets.map(p => p.id === id ? { ...p, pinned: !p.pinned } : p));

  const saveCommand = async () => {
    const command = (newCommand ?? "").trim();
    if (!command) { setNewCommand(null); return; }
    const name = ensureUniqueSavedTerminalCommandName(deriveSavedTerminalCommandName(command), savedCommands);
    const id = createCommandId(name);
    if (savedCommands.some(e => e.id === id && e.command !== command)) {
      setCommandError("A saved command already uses this name. Remove it first.");
      return;
    }
    const next = [...savedCommands, { id, name, command }];
    try {
      const settings = await getSettings().catch(() => ({} as Record<string, unknown>));
      await saveSettings(mergeSavedTerminalCommandsIntoSettings(settings, next) as Record<string, unknown>);
      setSavedCommands(next);
      setNewCommand(null);
      setCommandError(null);
    } catch {
      setCommandError("Failed to save command.");
    }
  };

  const removeCommand = async (id: string) => {
    const next = savedCommands.filter(e => e.id !== id);
    setSlots(s => ({ ...s, [id]: 0 }));
    try {
      const settings = await getSettings().catch(() => ({} as Record<string, unknown>));
      await saveSettings(mergeSavedTerminalCommandsIntoSettings(settings, next) as Record<string, unknown>);
      setSavedCommands(next);
    } catch {
      setCommandError("Failed to remove command.");
    }
  };

  // ⌘↵ = Launch, ⌘P = all presets, Esc = close, from anywhere in the view (Esc in a field stays the field's).
  const keysRef = useRef({ launch, cancel: onCancel, palette: () => {}, blocked: false });
  useEffect(() => {
    keysRef.current = { launch, cancel: onCancel, palette: () => presets.length > 0 && setPaletteOpen(true), blocked: paletteOpen };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A panel drawn over this view (the remote picker) owns its keys: ⌘↵ there must not launch here.
      const t = e.target;
      if (keysRef.current.blocked || e.defaultPrevented) return;
      if (t instanceof Element && t !== document.body && !rootRef.current?.contains(t)) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); keysRef.current.launch(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") { e.preventDefault(); keysRef.current.palette(); }
      else if (e.key === "Escape" && !e.defaultPrevented && !isTextField(e.target)) keysRef.current.cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onShapesKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = LAYOUT_TEMPLATES[LAYOUT_TEMPLATES.indexOf(selected) + (e.key === "ArrowRight" ? 1 : -1)];
    if (!next) return;
    chooseTemplate(next);
    const group = e.currentTarget;
    // A shape from "more" only exists after this render, so focus it on the next frame.
    requestAnimationFrame(() => (group.querySelector(`[data-tpl="${next.id}"]`) as HTMLElement | null)?.focus());
  };

  const commonShapes = LAYOUT_TEMPLATES.filter(t => COMMON_SESSIONS.has(t.sessions));
  const moreShapes = LAYOUT_TEMPLATES.filter(t => !COMMON_SESSIONS.has(t.sessions));
  const selectedIsMore = moreShapes.includes(selected);
  const shapeButton = (t: LayoutTemplate) => (
    <button key={t.id} type="button" role="radio" data-tpl={t.id} className="cl-shape"
      aria-checked={t.id === selected.id} tabIndex={t.id === selected.id ? 0 : -1}
      onClick={() => { chooseTemplate(t); setMoreOpen(false); }}>
      <MiniGrid tpl={t} />{t.sessions}
    </button>
  );

  return (
    <div className={cn("cl-view", ready && "is-ready")} ref={rootRef} aria-busy={!ready}>
      <div className="cl-col">
        <div className="cl-scroll">
          <div className="cl-main">
            <header className="cl-head">
              <div>
                <div className="cl-eyebrow">{loaded ? "Preset" : "Lotus"}</div>
                <h1>{loaded ? loaded.name : "New workspace"}</h1>
                <p className="cl-lede">
                  {loaded ? "Loaded from a preset. Your changes are saved to it when you launch." : "Pick a folder, shape the panes, drop in agents."}
                </p>
              </div>
              {loaded && <button type="button" className="cl-chip-btn is-outline" onClick={startFresh}>Start fresh</button>}
            </header>

            {presets.length > 0 && (
              <section>
                <div className="cl-label">
                  Jump back in
                  <button type="button" className="cl-seeall" onClick={() => setPaletteOpen(true)}>
                    All presets · {presets.length} <span className="cl-kbd">{shortcut("⌘P")}</span>
                  </button>
                </div>
                <div className="cl-recents">
                  {ordered.slice(0, 4).map(p => {
                    const tpl = templateOf(p);
                    const names = agentNames(p);
                    return (
                      <div key={p.id} className="cl-rc-wrap">
                      <button type="button" className="cl-rc" onClick={() => launchPreset(p)} title={`Open ${p.name}`}>
                        <span className="cl-rc-top">
                          <MiniGrid tpl={tpl} filled={Object.values(p.agentSlots).reduce((s, n) => s + Math.max(0, n), 0)} />
                          {p.pinned && <span className="cl-rc-pin">Pinned</span>}
                        </span>
                        <span className="cl-rc-name">{p.name}</span>
                        <span className="cl-rc-sub cl-mono">{p.location ? `${p.location.host}:${leafName(p.cwd)}` : leafName(p.cwd)}</span>
                        <span className="cl-rc-sub">{names.length > 0 ? names.join(", ") : plural(tpl.sessions, "shell")}</span>
                        <span className="cl-rc-go">Open ↵</span>
                      </button>
                      <button type="button" className="cl-rc-edit" onClick={() => loadPreset(p)}
                        aria-label={`Edit ${p.name}`} title="Edit before opening"><Pencil size={13} /></button>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            <section>
              <div className="cl-label">Folder <small>Every pane starts here</small></div>
              {remote ? (
                // A remote path comes from the machine's own browser; typing one here could not be checked.
                <div className="cl-field has-lead is-remote">
                  <button type="button" className="cl-src is-remote" onClick={pickRemote} title="Choose another machine or folder">
                    <Server size={15} />{remote.host}
                    <span className={cn("cl-src-st", `is-${machineState}`)} role="status">
                      {machineState === "checking" ? "checking…" : machineState === "connected" ? "● connected" : "● not reachable"}
                    </span>
                    <ChevronDown size={12} className="cl-src-car" />
                  </button>
                  <button type="button" className="cl-remote-path cl-mono" onClick={pickRemote} aria-label="Remote folder">{cwd}</button>
                  <button type="button" className="cl-chip-btn" onClick={backToMac}>Use this Mac</button>
                </div>
              ) : (
                <DirAutocomplete
                  value={cwd}
                  onChange={setCwd}
                  leading={onPickRemote ? (
                    <button type="button" className="cl-src" onClick={pickRemote} title="Open a folder on another machine">
                      <Monitor size={15} />This Mac<ChevronDown size={12} className="cl-src-car" />
                    </button>
                  ) : undefined}
                  trailing={<DirFacts cwd={cwd} />}
                />
              )}
              {atHome && (
                <p className="cl-warn"><AlertTriangle size={13} />This is your home folder, not a project. Agents will see every file in it.</p>
              )}
            </section>

            <section>
              <div className="cl-label">Panes &amp; agents <small>{plural(total, "pane")} · {selected.rows} × {selected.cols}</small></div>
              <div className="cl-build">
                <div className="cl-shapes" role="radiogroup" aria-label="Panes" onKeyDown={onShapesKeyDown}>
                  {commonShapes.map(shapeButton)}
                  {/* Bigger grids are rare: one "more" slot, which shows the pick once one is made. */}
                  {selectedIsMore ? shapeButton(selected) : null}
                  <button type="button" className={cn("cl-shape is-more", moreOpen && "is-open")} aria-expanded={moreOpen}
                    onClick={() => setMoreOpen(o => !o)}>
                    <span className="cl-shape-more">{selectedIsMore ? "other" : "more"} <ChevronDown size={11} /></span>
                  </button>
                  {moreOpen && (
                    <div className="cl-shapes-more">
                      {moreShapes.filter(t => t !== selected).map(shapeButton)}
                    </div>
                  )}
                </div>

                <div className="cl-preview" style={{ gridTemplateColumns: `repeat(${selected.cols},1fr)`, gridTemplateRows: `repeat(${selected.rows},1fr)` }}>
                  {Array.from({ length: total }, (_, i) => {
                    const agent = assigned[i];
                    return agent ? (
                      <button key={`${selected.id}-${i}`} type="button" className="cl-pane is-agent" style={{ animationDelay: `${i * 14}ms` }}
                        onClick={() => removeAgent(agent.id)} aria-label={`Remove ${agent.name} from pane ${i + 1}`} title="Click to remove">
                        <span className="cl-pane-head"><AgentIcon agent={agent} size={12} />{agent.name}</span>
                        <span className="cl-pane-line" style={{ width: `${55 + ((i * 37) % 40)}%` }} />
                        <span className="cl-pane-line" style={{ width: `${30 + ((i * 53) % 50)}%` }} />
                        <X size={12} className="cl-pane-x" />
                      </button>
                    ) : (
                      <div key={`${selected.id}-${i}`} className="cl-pane" style={{ animationDelay: `${i * 14}ms` }}>
                        <span className="cl-pane-head">shell {i + 1}</span>
                        <span className="cl-pane-line" style={{ width: `${40 + ((i * 37) % 30)}%` }} />
                      </div>
                    );
                  })}
                </div>

                <div className="cl-chips" aria-label="Agents">
                  {chips.map((d, i) => {
                    const n = counts.get(d.id) ?? 0;
                    const saved = savedCommands.some(c => c.id === d.id);
                    return (
                      <span key={d.id} className="cl-chips-item">
                        {i === pickedCount && pickedCount > 0 && <span className="cl-chips-sep" />}
                        {n > 0 ? (
                          <span className={cn("cl-chip is-on", missingOnMachine(d) && "is-warn")}
                            title={missingOnMachine(d) ? `${d.command} is ${missingNote}; this pane will not start` : undefined}>
                            <button type="button" className="cl-chip-main" disabled={free <= 0}
                              onClick={e => addAgent(d.id, e.shiftKey)} title={`Add one more ${d.name} pane`}>
                              <AgentIcon agent={d} size={14} />{d.name}
                            </button>
                            <span className="cl-step">
                              <button type="button" onClick={() => removeAgent(d.id)} aria-label={`Fewer ${d.name}`}>−</button>
                              <output aria-label={`${d.name} panes`}>{n}</output>
                              <button type="button" onClick={() => addAgent(d.id)} disabled={free <= 0} aria-label={`More ${d.name}`}>+</button>
                            </span>
                          </span>
                        ) : (
                          <span className={cn("cl-chip", missingOnMachine(d) && "is-missing")}>
                            <button type="button" className="cl-chip-main" disabled={free <= 0 || (!!remote && missingOnMachine(d))}
                              onClick={e => addAgent(d.id, e.shiftKey)}
                              title={missingOnMachine(d) ? `${d.command} is ${missingNote}`
                                : free > 0 ? `Put ${d.name} in the next empty pane` : "Every pane has an agent — remove one first"}>
                              <AgentIcon agent={d} size={14} /><span className="cl-chip-plus">+</span>{d.name}
                              {missingOnMachine(d) && <span className="cl-chip-note">{missingNote}</span>}
                            </button>
                            {d.isCustom && saved && (
                              <button type="button" className="cl-chip-del" onClick={() => removeCommand(d.id)}
                                aria-label={`Remove ${d.name}`} title={`Remove the saved command “${d.command}”`}><X size={11} /></button>
                            )}
                          </span>
                        )}
                      </span>
                    );
                  })}
                  {hiddenChips.length > 0 && (
                    <button type="button" className="cl-chip is-dash" aria-expanded={agentsMoreOpen} onClick={() => setAgentsMoreOpen(o => !o)}>
                      {agentsMoreOpen ? "Fewer" : `+ ${hiddenChips.length} more`}
                    </button>
                  )}
                  {newCommand === null ? (
                    <button type="button" className="cl-chip is-dash" onClick={() => { setNewCommand(""); setCommandError(null); }}>+ Custom command</button>
                  ) : (
                    <input className="cl-chip-input cl-mono" autoFocus value={newCommand} spellCheck={false}
                      aria-label="Add a custom command" placeholder="e.g. bun x my-agent --profile prod  ↵"
                      onChange={e => { setNewCommand(e.target.value); setCommandError(null); }}
                      onBlur={() => { if (!newCommand.trim()) setNewCommand(null); }}
                      onKeyDown={e => {
                        if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); void saveCommand(); }
                        if (e.key === "Escape") { e.preventDefault(); setNewCommand(null); }
                      }} />
                  )}
                </div>
                {commandError && <p className="cl-error" role="alert">{commandError}</p>}
                {remote && (
                  <p className="cl-runs"><Server size={13} />Agents run <b>on {remote.host}</b>, so each CLI must be installed there.</p>
                )}

                <div className="cl-tip">
                  <span>
                    {free > 0
                      ? `${plural(free, "empty pane")} · click an agent to fill the next one · ⇧-click fills all`
                      : "Every pane has an agent · use − on a chip or click a pane to free one"}
                  </span>
                  {assigned.length > 0 && <button type="button" onClick={() => setSlots({})}>Clear agents</button>}
                </div>
              </div>
            </section>
          </div>
        </div>

        <div className="cl-pfoot">
          <div className="cl-pfoot-in">
            <button type="button" className="cl-esc" onClick={onCancel}><span className="cl-kbd">Esc</span>Cancel</button>
            {!loaded && (
              <label className="cl-check">
                <input type="checkbox" checked={saveAsPreset}
                  onChange={e => {
                    setSaveAsPreset(e.target.checked);
                    setNameError(null);
                    if (e.target.checked) requestAnimationFrame(() => presetNameRef.current?.focus());
                  }} />
                Save as preset
              </label>
            )}
            {saveAsPreset && !loaded && (
              <input ref={presetNameRef} className="cl-pname" value={newPresetName} aria-label="Preset name" aria-invalid={nameError != null}
                placeholder={`Name, e.g. ${leafName(cwd) || "My project"}`}
                onChange={e => { setNewPresetName(e.target.value); setNameError(null); }} />
            )}
            {nameError && <span className="cl-error" role="alert">{nameError}</span>}
            <span className="cl-pfoot-grow" />
            <button type="button" className="cl-btn is-primary" onClick={launch}>
              Launch {plural(total, "pane")}{remote && <>{" "}<span className="cl-btn-dest">on {remote.host}</span></>} <span className="cl-kbd">{shortcut("⌘↵")}</span>
            </button>
          </div>
        </div>
      </div>

      {paletteOpen && (
        <PresetPalette
          presets={presets}
          agentNames={agentNames}
          onOpen={launchPreset}
          onEdit={loadPreset}
          onRename={renamePreset}
          onDelete={deletePreset}
          onTogglePin={togglePin}
          onClose={() => { setPaletteOpen(false); setUndo(null); }}
          undo={undo}
        />
      )}
    </div>
  );
}

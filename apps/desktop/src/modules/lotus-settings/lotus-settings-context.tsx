"use client";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { LotusSettingsModal } from "./components/LotusSettingsModal";
import { SETTINGS_SECTIONS, type SettingsSectionEntry } from "./settings-sections";
import { resolveSettingsSection, type SettingsMode, type SettingsOpenRequest } from "./services/open-request";

/** Per-viewer convenience: ⌘, reopens where the user left off. */
export const LAST_SECTION_STORAGE_KEY = "lotus-settings-last-section-v1";

/**
 * What the mode on screen tells Lotus Settings: which mode it is, and — for the canvas — the theme
 * to paint the modal with. The canvas injects its own Canvas Style here, so the modal looks the
 * way it always did over the canvas, while Code and Chat leave the theme empty and the modal falls
 * back to the app's Appearance (see `.lotus-settings-scope` in settings-modal.css).
 *
 * Registered by the mode, not detected from the route: it keeps the dependency one-way — the
 * modes know Lotus Settings, Lotus Settings knows no mode's internals.
 */
export interface LotusSettingsHost {
  mode: SettingsMode;
  themeStyle?: CSSProperties;
  themeAttributes?: Record<`data-${string}`, string | undefined>;
}

interface LotusSettingsApi {
  open: boolean;
  openSettings: (request?: SettingsOpenRequest) => void;
  closeSettings: () => void;
}

const LotusSettingsContext = createContext<LotusSettingsApi | null>(null);
const LotusSettingsHostContext = createContext<((host: LotusSettingsHost) => () => void) | null>(null);

const NOOP_API: LotusSettingsApi = { open: false, openSettings: () => {}, closeSettings: () => {} };

/** Open or close Lotus Settings from anywhere. Outside the provider (isolated tests) it does nothing. */
export function useLotusSettings(): LotusSettingsApi {
  return useContext(LotusSettingsContext) ?? NOOP_API;
}

/** Called by the mode on screen; pass `null` while the mode is parked or hidden. */
export function useLotusSettingsHost(host: LotusSettingsHost | null): void {
  const register = useContext(LotusSettingsHostContext);
  useEffect(() => {
    if (!register || !host) return;
    return register(host);
  }, [register, host]);
}

function readRemembered(): string | null {
  try {
    return localStorage.getItem(LAST_SECTION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function remember(id: string): void {
  try {
    localStorage.setItem(LAST_SECTION_STORAGE_KEY, id);
  } catch {
    // Private window or blocked storage: the hotkey falls back to the mode's group.
  }
}

function isSettingsChord(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key === ",";
}

export function LotusSettingsProvider({
  children,
  sections = SETTINGS_SECTIONS,
}: {
  children: React.ReactNode;
  sections?: readonly SettingsSectionEntry[];
}) {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState(sections[0]?.id ?? "");
  const [host, setHost] = useState<LotusSettingsHost | null>(null);
  // Read by `openSettings` at click time; kept in step after each commit, not during render.
  const hostRef = useRef(host);
  useLayoutEffect(() => {
    hostRef.current = host;
  }, [host]);

  // Unregister only our own host: a mode leaving must not clear the one that just arrived.
  const registerHost = useCallback((next: LotusSettingsHost) => {
    setHost(next);
    return () => setHost((current) => (current === next ? null : current));
  }, []);

  const select = useCallback((id: string) => {
    setActiveId(id);
    remember(id);
  }, []);

  const openSettings = useCallback(
    (request: SettingsOpenRequest = { from: "hotkey" }) => {
      select(resolveSettingsSection(sections, request, { remembered: readRemembered(), mode: hostRef.current?.mode ?? null }));
      setOpen(true);
    },
    [sections, select],
  );
  const closeSettings = useCallback(() => setOpen(false), []);

  // ⌘, from every mode. Capture phase so a focused terminal or editor cannot swallow it first.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isSettingsChord(event)) return;
      event.preventDefault();
      if (open) closeSettings();
      else openSettings({ from: "hotkey" });
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [open, openSettings, closeSettings]);

  const api = useMemo(() => ({ open, openSettings, closeSettings }), [open, openSettings, closeSettings]);

  return (
    <LotusSettingsContext.Provider value={api}>
      <LotusSettingsHostContext.Provider value={registerHost}>
        {children}
        <LotusSettingsModal
          open={open}
          onClose={closeSettings}
          sections={sections}
          activeId={activeId}
          onSelect={select}
          themeStyle={host?.themeStyle}
          themeAttributes={host?.themeAttributes}
        />
      </LotusSettingsHostContext.Provider>
    </LotusSettingsContext.Provider>
  );
}

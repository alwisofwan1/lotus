"use client";
import { useState, useEffect, useCallback, createContext, useContext, useRef, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isTauri, openNewWindow, setCurrentWindowTitle } from "@/lib/tauri-api";
import { isMonacoCancellationError } from "@/lib/monaco-cancellation";
import { isTauriCancelationError, tauriInvoke } from "@/lib/tauri/runtime";
import { countUnsavedEditorFiles, onUnsavedEditorFilesChange } from "@/modules/codespace/services/editor-file-store";
import { discardEditorBackups, startEditorBackups } from "@/modules/codespace/services/editor-backups";
import { installNativeClipboardShim } from "@/lib/native-clipboard-shim";
import { installCspViolationLog } from "@/lib/csp-violation-log";
import { WindowChrome } from "@/components/chrome/WindowChrome";
import { WindowsTitleBar } from "@/components/chrome/WindowsTitleBar";
// Imported by path rather than through the barrel for the same reason as MusicMiniPlayer below:
// this shell is mounted here, not by `app/page.tsx`, so it must not drag the whole module graph
// into routes that never draw it.
import { WorkspaceShellPage } from "@/modules/workspace-shell/containers/WorkspaceShellPage";
import { TrackerBoardProvider } from "@/modules/workspace-shell/hooks/TrackerBoardProvider";
// Imported by path, not through the codecanvas barrel, so the shell does not pull
// CanvasPage (and the whole ReactFlow graph) into every route's bundle.
import { MusicMiniPlayer } from "@/modules/codecanvas/components/MusicMiniPlayer";
import { isMacCloseFocusedTerminalPaneShortcut } from "@/modules/codespace/services/pane-keyboard-shortcuts";
import {
  createRecentPaneCloseRequestSuppressor,
  handleTerminalShutdownCloseRequest,
} from "@/modules/codespace/services/shutdown-policy";
import { TerminalV2RuntimeProvider } from "@/modules/codespace/terminal-v2";
import { Sidebar } from "@/modules/shell/components/Sidebar";
import { QuitAgentsGuard } from "@/modules/shell/components/QuitAgentsGuard";
import { persistLastActiveShellDestination } from "@/modules/shell/services/last-shell-destination";
import { subscribeToOpenAsk } from "@/modules/automation/services/automation-api";
import { requestOpenAsk } from "@/modules/automation/services/open-ask-request";
import { safeTauriUnlisten } from "@/lib/tauri-listener-cleanup";
import { VoiceHotkeyProvider } from "@/modules/voice-core/voice-hotkey-context";
import { LotusSettingsProvider } from "@/modules/lotus-settings/lotus-settings-context";
import { SurfaceVisible } from "@/lib/surface-visible";

interface SidebarCtx {
  collapsed: boolean;
  toggle: () => void;
}

const SidebarContext = createContext<SidebarCtx>({
  collapsed: false,
  toggle: () => {},
});

export function useSidebar() {
  return useContext(SidebarContext);
}

function detectMacOverlayChrome(): boolean {
  if (typeof navigator === "undefined") return false;
  return isTauri() && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

type DesktopPlatform = "mac" | "windows" | "linux" | "unknown";

function detectDesktopPlatform(): DesktopPlatform {
  if (typeof navigator === "undefined") return "unknown";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = `${nav.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent}`.toLowerCase();
  if (platform.includes("mac") || platform.includes("iphone") || platform.includes("ipad") || platform.includes("ipod")) return "mac";
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux") || platform.includes("x11")) return "linux";
  return "unknown";
}

function useMacOverlayChrome(): boolean {
  return useSyncExternalStore(
    () => () => {},
    detectMacOverlayChrome,
    () => false,
  );
}

function useDesktopPlatform(): DesktopPlatform {
  return useSyncExternalStore(
    () => () => {},
    detectDesktopPlatform,
    () => "unknown",
  );
}

function isReloadShortcut(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase();
  return event.key === "F5" || ((event.metaKey || event.ctrlKey) && key === "r");
}

function isWithinTerminal(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(".xterm"));
}

function titleFromPathname(pathname: string): string {
  if (pathname === "/") return "Home";
  if (pathname === "/canvas") return "CodeCanvas";

  const segment = pathname
    .split("/")
    .filter(Boolean)
    .at(-1)
    ?.replace(/-/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());

  return segment ?? "Lotus";
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [layoutHydrated, setLayoutHydrated] = useState(false);
  const [keepShellMounted, setKeepShellMounted] = useState(false);
  const allowWindowCloseRef = useRef(false);
  const paneCloseSuppressorRef = useRef(createRecentPaneCloseRequestSuppressor());

  // WKWebView refuses clipboard writes outside a fresh gesture; Monaco pre-arms one on every
  // click and logs each refusal. See `native-clipboard-shim.ts`.
  useEffect(() => installNativeClipboardShim(), []);
  // The production CSP blocks silently; each blocked load goes to `csp-violations.log`.
  useEffect(() => installCspViolationLog(), []);

  const isHome = pathname === "/";
  const router = useRouter();
  const onHome = useRef(isHome);
  const onCanvas = useRef(pathname === "/canvas");
  useEffect(() => {
    onHome.current = isHome;
    onCanvas.current = pathname === "/canvas";
  }, [isHome, pathname]);
  // Following an Ask's notification opens Automation › Inbox on it (PLAN §8 Q10). The workspace
  // shell and the Canvas Dock both host Inbox (plans/canvas-dock/ S2), so only other pages go Home:
  // the canvas never navigates away to answer an Ask.
  useEffect(
    () =>
      subscribeToOpenAsk((askId) => {
        requestOpenAsk(askId);
        if (!onHome.current && !onCanvas.current) router.push("/");
      }),
    [router],
  );
  const isCodeCanvas = pathname === "/canvas";
  // `/settings` only opens Lotus Settings and replaces itself with the last mode
  // (`LegacySettingsRoute`): it draws nothing, so the frame it is on screen must not flash the
  // sidebar or a chrome strip.
  const isSettingsPassThrough = pathname.startsWith("/settings");
  const hideSidebar = isHome || isCodeCanvas || isSettingsPassThrough;
  const isMacOverlayChrome = useMacOverlayChrome();
  const desktopPlatform = useDesktopPlatform();
  // CodeCanvas renders its own top bar (CanvasTopBar) as the window chrome —
  // it carries data-tauri-drag-region and reserves the macOS traffic-light zone.
  // Treat it as dedicated chrome so AppShell does not stack a second empty 36px
  // strip above it (and does not add the matching 36px top padding).
  // `/` is the unified workspace shell now, and it draws its own title bar — AppShell must not
  // stack a second empty strip above it. The old launcher lives at /home.
  const hasDedicatedChrome = isCodeCanvas || isHome || isSettingsPassThrough;
  const dragRegionEnabled = mounted && isTauri();
  const desktopWindowControls = dragRegionEnabled && !isMacOverlayChrome;
  // Windows overlays its window buttons on the top-right of the route's own top bar (no title row).
  const windowsTitleBar = dragRegionEnabled && desktopPlatform === "windows";
  const windowsLikeWindowControls = desktopWindowControls && (desktopPlatform === "windows" || desktopPlatform === "unknown");
  // Routes without a top bar of their own get a 36px drag strip: under the traffic lights on macOS,
  // under the window buttons on Windows.
  const defaultChromeHeight = dragRegionEnabled && (isMacOverlayChrome || windowsTitleBar) && !hasDedicatedChrome ? 36 : 0;
  const mainTopPadding = defaultChromeHeight;
  const disableReloadShortcutInThisSession =
    mounted && isTauri() && process.env.NODE_ENV === "production";
  /**
   * The shell stays mounted while the window is somewhere that owns nothing — CodeCanvas, the
   * launcher, settings.
   *
   * That is what makes the mode switcher's third segment survivable. `Canvas` is a route push
   * (CodeCanvas keeps its own chrome, by the plan's binding constraint), which used to unmount
   * the shell, take every terminal down with it and — before the reap became a once-per-window
   * job — kill the window's PTYs on the way back in. Parked, the shell keeps its panes attached
   * and its sessions running; it is only invisible.
   */
  const shouldRenderShell = isHome || keepShellMounted;

  const toggle = useCallback(() => {
    setCollapsed((value) => {
      const next = !value;
      localStorage.setItem("sidebar-collapsed", String(next));
      return next;
    });
  }, []);

  useEffect(() => {
    // Client-only mount gate for Tauri chrome behavior.
    setMounted(true);
  }, []);

  useEffect(() => {
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (!isTauriCancelationError(event.reason) && !isMonacoCancellationError(event.reason)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    window.addEventListener("unhandledrejection", handleUnhandledRejection, true);
    return () => window.removeEventListener("unhandledrejection", handleUnhandledRejection, true);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document.documentElement.setAttribute("data-ui-ready", "true");
    });

    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Hydrate persisted shell layout from browser storage once on the client.
    setCollapsed(localStorage.getItem("sidebar-collapsed") === "true");
    setLayoutHydrated(true);
  }, []);

  useEffect(() => {
    persistLastActiveShellDestination(pathname);
  }, [pathname]);

  useEffect(() => {
    void setCurrentWindowTitle(titleFromPathname(pathname)).catch((error) => {
      console.warn("[shell] failed to update window title:", error);
    });
  }, [pathname]);

  // Same shape as the line above, for the shell: once visited it is kept, and the exclusivity
  // rule above decides where "kept" still applies.
  useEffect(() => {
    if (!isHome || keepShellMounted) return;
    const timer = window.setTimeout(() => setKeepShellMounted(true), 0);
    return () => window.clearTimeout(timer);
  }, [isHome, keepShellMounted]);

  useEffect(() => {
    if (!layoutHydrated) return;
    const onKey = (event: KeyboardEvent) => {
      /*
        ⌘W closes a PANE, and the window must not take it as an instruction to close too.

        This guard was gated on `/terminal`, so it protected CodeSpace and never the shell — which
        binds the same chord for the same job (`isClosePaneShortcut`). Retiring CodeSpace would
        have removed the guard entirely and left the gap in the only surface left, so it moves to
        the surface that now owns panes. The suppressor forgets after a second and is consumed on
        read, so a genuine ⌘W with nothing to close still closes the window.
      */
      if (isHome && isMacCloseFocusedTerminalPaneShortcut(event)) {
        paneCloseSuppressorRef.current.recordPaneCloseShortcut();
      }

      if (disableReloadShortcutInThisSession && isReloadShortcut(event)) {
        const terminalCtrlR =
          event.ctrlKey &&
          !event.metaKey &&
          event.key.toLowerCase() === "r" &&
          isWithinTerminal(event.target);
        if (!terminalCtrlR) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      // Only where there IS a sidebar to collapse. This listener is in the capture phase, so on
      // the routes that hide the sidebar — the unified shell at `/` among them — it used to
      // consume Cmd+B for something invisible, and the surface underneath never heard the key.
      if (!hideSidebar && (event.ctrlKey || event.metaKey) && event.key === "b") {
        event.preventDefault();
        toggle();
      } else if ((event.ctrlKey || event.metaKey) && event.key === "n") {
        event.preventDefault();
        void openNewWindow(pathname);
      }
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [disableReloadShortcutInThisSession, hideSidebar, isHome, layoutHydrated, pathname, toggle]);

  useEffect(() => {
    if (!mounted || !isTauri()) return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;

    Promise.all([
      import("@tauri-apps/api/window"),
      import("@tauri-apps/plugin-dialog"),
      import("@/lib/tauri-api"),
    ])
      .then(([windowApi, dialogApi, tauriApi]) => {
        if (cancelled) return;
        const appWindow = windowApi.getCurrentWindow();
        return appWindow.onCloseRequested((event) => {
          void handleTerminalShutdownCloseRequest(event, {
            listSessions: tauriApi.listPtySessions,
            killSession: tauriApi.killPtySession,
            confirm: dialogApi.confirm,
            closeWindow: () => appWindow.close(),
            isCloseAllowed: () => allowWindowCloseRef.current,
            allowClose: () => {
              allowWindowCloseRef.current = true;
              // The user chose to lose them: a quit that follows this close must not stop for them.
              void tauriInvoke("editor_report_unsaved", { count: 0 }).catch(() => {});
            },
            shouldSuppressCloseRequest: () => paneCloseSuppressorRef.current.shouldSuppressCloseRequest(),
            countUnsavedFiles: countUnsavedEditorFiles,
            discardUnsavedFiles: discardEditorBackups,
          });
        });
      })
      .then((dispose) => {
        if (cancelled) {
          dispose?.();
          return;
        }
        unlisten = dispose ?? null;
      })
      .catch((error) => {
        console.warn("[codespace] failed to install terminal shutdown policy:", error);
      });

    return () => {
      cancelled = true;
      safeTauriUnlisten(unlisten);
    };
  }, [mounted]);

  // Unsaved editor files: Rust keeps the count per window so ⌘Q, which skips every window's
  // close handler, stops and sends the question here (`editor_unsaved.rs`).
  useEffect(() => {
    if (!mounted || !isTauri()) return;
    const report = (count: number) => {
      void tauriInvoke("editor_report_unsaved", { count }).catch(() => {});
    };
    report(countUnsavedEditorFiles());
    const stopReporting = onUnsavedEditorFilesChange(report);
    // Hot exit: unsaved buffers are copied to disk, and come back after a crash.
    const stopBackups = startEditorBackups();

    let unlisten: (() => void) | null = null;
    let cancelled = false;
    Promise.all([import("@tauri-apps/api/event"), import("@tauri-apps/plugin-dialog")])
      .then(([eventApi, dialogApi]) => eventApi.listen<number>("lotus://quit-blocked-unsaved", (event) => {
        const count = event.payload || countUnsavedEditorFiles();
        const files = count === 1 ? "1 file has" : `${count} files have`;
        void dialogApi.confirm(`${files} unsaved changes. Quit Lotus and lose them?`, {
          title: "Discard unsaved changes?",
          kind: "warning",
          okLabel: "Quit Without Saving",
          cancelLabel: "Cancel",
        }).then((quit) => {
          if (!quit) return;
          void discardEditorBackups()
            .catch(() => {})
            .then(() => tauriInvoke("editor_quit_discarding"))
            .catch(() => {});
        });
      }))
      .then((dispose) => {
        if (cancelled) dispose();
        else unlisten = dispose;
      })
      .catch((error) => {
        console.warn("[editor] failed to install the unsaved-changes quit guard:", error);
      });

    return () => {
      cancelled = true;
      stopReporting();
      stopBackups();
      safeTauriUnlisten(unlisten);
    };
  }, [mounted]);

  return (
    <TerminalV2RuntimeProvider activationRequested={shouldRenderShell}>
      {/* App-wide Push-to-Talk / Live Voice keys: the mode on screen claims them, others get a hint. */}
      <VoiceHotkeyProvider>
      {/* The window's one tracker board: the shell's Tasks and the Canvas Dock's read it (canvas-dock S4). */}
      <TrackerBoardProvider>
      {/* The one settings window (ADR-0054), here so ⌘, opens it from every route. */}
      <LotusSettingsProvider>
      <SidebarContext.Provider value={{ collapsed, toggle }}>
      {/* 44px on `/`, to sit flush with the workspace shell's title bar (`.ws-chrome`). */}
      {windowsTitleBar && <WindowsTitleBar height={isHome ? 44 : 36} />}
      {!hideSidebar && <Sidebar />}
      {defaultChromeHeight > 0 && (
        <WindowChrome
          className={`shell-chrome fixed left-0 right-0 top-0 z-50 h-9${isHome ? " home-shell-chrome" : ""}`}
          dragRegionEnabled={dragRegionEnabled}
          contentClassName="items-center px-3.5"
          centerDragRegionClassName="min-w-0 flex-1 self-stretch"
          leftContent={<div className="pointer-events-none w-[86px] shrink-0" aria-hidden="true" />}
        />
      )}
      <main
        className={
          hideSidebar
            ? "app-shell-main flex-1 min-w-0 overflow-hidden"
            : "app-shell-main flex-1 overflow-auto min-w-0 transition-[padding-left] duration-200 ease-in-out"
        }
        style={{
          paddingTop: mainTopPadding,
          ["--app-shell-top-offset" as string]: `${mainTopPadding}px`,
        }}
      >
        {shouldRenderShell && (
          /*
            Parked, not hidden with `display: none`.

            A pane taken out of layout releases its slot in the renderer pool, and getting it back
            costs a re-attach per terminal — measured at 192ms for two panes when mode switching
            did this, which is why the shell's own modes hide with opacity. The same rule applies
            one level up: `.app-shell-parked` keeps the shell at full size and merely invisible,
            so a trip to the canvas costs nothing to come back from. `inert` stops it taking
            focus; `shown` stops it hearing the keyboard.
          */
          <div
            className={isHome ? "contents" : "app-shell-parked"}
            aria-hidden={!isHome}
            inert={!isHome}
          >
            <SurfaceVisible visible={isHome}>
              <WorkspaceShellPage shown={isHome} />
            </SurfaceVisible>
          </div>
        )}
        {!isHome ? children : null}
      </main>
      {/* Mounted here, in the root layout's shell, on purpose: the music player must
          outlive project switches and route changes, and its <iframe> cannot be
          re-parented without reloading. See plans/canvas-music-persistent-playback.
          It sits in the top-right chrome band, so it has to clear the window controls
          on the platforms that put them there (macOS keeps them top-left). */}
      <QuitAgentsGuard />
      <MusicMiniPlayer
        rightOffsetPx={windowsTitleBar ? 188 : desktopWindowControls ? (windowsLikeWindowControls ? 150 : 104) : 14}
      />
      </SidebarContext.Provider>
      </LotusSettingsProvider>
      </TrackerBoardProvider>
      </VoiceHotkeyProvider>
    </TerminalV2RuntimeProvider>
  );
}

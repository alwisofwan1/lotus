"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { parsePtySessionEnd } from "@/lib/pty-session-end";
import { PtySessionController } from "@/lib/pty-session-controller";
import {
  attachPersistentPty,
  createPersistentPty,
  detachPersistentPty,
  destroyPersistentPty,
  getPersistentPtySnapshot,
  dispatchPersistentPtyOutput,
  getPersistentPtyController,
  hasPersistentPty,
  markPersistentPtyConnected,
  markPersistentPtyError,
} from "@/lib/pty-session-pool";
import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";

export type PtyStatus = "connecting" | "connected" | "ended" | "error";

export interface PtyHandle {
  readonly sessionId: string | null;
  readonly status: PtyStatus;
  /**
   * How the session came up: "command" = direct shell-less spawn (the CLI is the PTY child);
   * "shell" = login shell (caller types any launch command). Null/absent while connecting —
   * optional so existing fakes (which are always shell-mode) stay valid.
   */
  readonly mode?: "command" | "shell" | null;
  /**
   * True when this mount reattached to an already-running persistent session (a `persistKey`
   * session that survived a project switch) rather than spawning a fresh one. Consumers use it to
   * skip their one-time launch sequence (typing the launch command, auto-submitting the initial
   * task) so a switch-and-return does NOT re-launch or double-dispatch a still-running agent.
   */
  readonly reattached?: boolean;
  write(data: string): void;
  /** Receipt-bearing write for flows that must await native PTY acceptance. */
  writeConfirmed?(data: string): Promise<void>;
  resize(cols: number, rows: number): void;
}

export interface UsePtySessionOptions {
  /** Working directory for the local PTY child shell. */
  cwd: string;
  cols?: number;
  rows?: number;
  onOutput: (data: string) => void;
  onExit?: (code: number) => void;
  /** Which machine the session runs on. A remote one is a local PTY whose child is `ssh`. */
  location?: CodeSpaceStoredWorkspaceLocation | null;
  /**
   * Pane/node id exported into the shell as LOTUS_PANE_ID. Agent CLIs (and their stop hooks)
   * inherit it — the correlation key that lets hook turn-events map back to this pane.
   */
  paneId?: string;
  /** Canvas node id exported as AGENT_CANVAS_TERMINAL_ID for paired BrowserNode/API access. */
  canvasTerminalId?: string;
  /**
   * argv for a direct (shell-less) spawn: the command becomes the PTY child, skipping the login
   * shell + typed-command hop. Falls back to a plain shell session when the spawn fails; the
   * resulting mode is reported on the handle so callers know whether to type the command.
   */
  command?: string[] | null;
  /**
   * Defer connecting while true (status stays "connecting"). Lets a caller wait for async launch
   * config to resolve instead of spawning a shell it will immediately kill and replace.
   */
  hold?: boolean;
  /**
   * Opt into the persistent PTY pool. When set, the session survives React unmount (project
   * switch): unmount detaches the sink instead of killing the PTY, and a later remount with the
   * same key reattaches to the live process and replays its transcript. The PTY is only killed by
   * an explicit `destroyPersistentPty(persistKey)` (node close / project close). Without it, the
   * session keeps the original ephemeral abort-on-unmount behaviour.
   */
  persistKey?: string;
  /** Claude account the session runs on (issues/07); absent = the globally chosen one. */
  claudeAccount?: string | null;
  /** Project scope (`canvas:{projectId}`) for `destroyScopePersistentPtys` on project close. */
  persistScope?: string;
}

export function usePtySession(options: UsePtySessionOptions): PtyHandle {
  const { cwd, cols = 80, rows = 24, onOutput, onExit, location, paneId, canvasTerminalId, command, hold = false, persistKey, persistScope, claudeAccount = null } = options;
  // Stable key so a re-render with an identical argv array does not reconnect the PTY.
  const commandKey = command && command.length > 0 ? JSON.stringify(command) : "";
  // Track location via a stable JSON key so changes to nested fields trigger
  // reconnection without rerunning the effect on every parent render.
  const locationKey = location ? JSON.stringify(location) : "";
  const [status, setStatus] = useState<PtyStatus>("connecting");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [mode, setMode] = useState<"command" | "shell" | null>(null);
  const [reattached, setReattached] = useState(false);
  const controllerRef = useRef<PtySessionController | null>(null);

  // Stable refs for callbacks — avoids re-triggering the effect
  const onOutputRef = useRef(onOutput);
  const onExitRef = useRef(onExit);

  useEffect(() => {
    onOutputRef.current = onOutput;
    onExitRef.current = onExit;
  }, [onExit, onOutput]);

  useEffect(() => {
    if (hold) return;

    // ── Persistent path: survive React unmount (project switch) ──────────────────────────────
    // Reattach to a live pooled session if one exists for this key, else register a new one and
    // connect it. Unmount only detaches (PTY stays alive); an explicit destroyPersistentPty kills it.
    if (persistKey) {
      const key = persistKey;
      const dataSink = (data: string) => onOutputRef.current(data);
      const endSink = (code: number) => {
        setStatus("ended");
        onExitRef.current?.(code);
      };

      // Failed spawns have no live PTY to adopt; give the next mount a fresh attempt.
      if (getPersistentPtySnapshot(key)?.status === "error") {
        destroyPersistentPty(key);
      }

      if (hasPersistentPty(key)) {
        // Reattach: reuse the running controller, replay its transcript, adopt its status.
        controllerRef.current = getPersistentPtyController(key);
        setReattached(true);
        const snap = attachPersistentPty(key, dataSink, endSink);
        if (snap) {
          setMode(snap.mode);
          setSessionId(snap.sessionId);
          setStatus(snap.status === "ended" ? "ended" : snap.status === "error" ? "error" : snap.status === "connected" ? "connected" : "connecting");
        }
        return () => {
          detachPersistentPty(key);
          controllerRef.current = null;
        };
      }

      // Fresh persistent session: register, wire the output funnel, then connect.
      const ctrl = new PtySessionController(claudeAccount);
      controllerRef.current = ctrl;
      createPersistentPty(key, persistScope ?? key, ctrl);
      setReattached(false);
      setStatus("connecting");
      setSessionId(null);
      setMode(null);
      attachPersistentPty(key, dataSink, endSink);

      (async () => {
        const handleOutput = (data: string) => dispatchPersistentPtyOutput(key, data);
        try {
          let resolvedMode: "command" | "shell";
          if (commandKey) {
            resolvedMode = await ctrl.connectPreferCommand(
              cwd,
              JSON.parse(commandKey) as string[],
              cols,
              rows,
              handleOutput,
              paneId,
              canvasTerminalId,
              location,
            );
          } else {
            await ctrl.connect(cwd, cols, rows, handleOutput, paneId, location, canvasTerminalId);
            resolvedMode = "shell";
          }
          if (!ctrl.isAborted()) {
            markPersistentPtyConnected(key, resolvedMode, ctrl.getSessionId());
            setMode(resolvedMode);
            setStatus("connected");
            setSessionId(ctrl.getSessionId());
          }
        } catch {
          if (!ctrl.isAborted()) {
            markPersistentPtyError(key);
            setStatus("error");
          }
        }
      })();

      return () => {
        detachPersistentPty(key);
        controllerRef.current = null;
      };
    }

    // ── Ephemeral path: abort (kill) on unmount ──────────────────────────────────────────────
    const ctrl = new PtySessionController(claudeAccount);
    controllerRef.current = ctrl;

    async function connectSession() {
      setStatus("connecting");
      setSessionId(null);
      setMode(null);

      const handleOutput = (data: string) => {
        const exitCode = parsePtySessionEnd(data);
        if (exitCode !== null) {
          setStatus("ended");
          onExitRef.current?.(exitCode);
        } else {
          onOutputRef.current(data);
        }
      };

      try {
        let resolvedMode: "command" | "shell";
        if (commandKey) {
          resolvedMode = await ctrl.connectPreferCommand(
            cwd,
            JSON.parse(commandKey) as string[],
            cols,
            rows,
            handleOutput,
            paneId,
            canvasTerminalId,
            location,
          );
        } else {
          await ctrl.connect(cwd, cols, rows, handleOutput, paneId, location, canvasTerminalId);
          resolvedMode = "shell";
        }

        if (!ctrl.isAborted()) {
          // Mode BEFORE status: consumers key their launch effect on "connected" and must be
          // able to read how the session came up in that same render.
          setMode(resolvedMode);
          setStatus("connected");
          setSessionId(ctrl.getSessionId());
        }
      } catch {
        if (!ctrl.isAborted()) {
          setStatus("error");
        }
      }
    }

    void connectSession();

    return () => {
      ctrl.abort(); // THE FIX: always cleans up, even if still connecting
      controllerRef.current = null;
    };
    // location is captured via locationKey so deep changes to host/port/cwd
    // trigger reconnection while object identity churn alone does not.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cols, cwd, rows, locationKey, paneId, canvasTerminalId, commandKey, hold, persistKey, persistScope, claudeAccount]);

  return useMemo(
    () => ({
      sessionId,
      status,
      mode,
      reattached,
      write: (data: string) => controllerRef.current?.write(data),
      writeConfirmed: (data: string) => {
        const controller = controllerRef.current;
        return controller
          ? controller.writeConfirmed(data)
          : Promise.reject(new Error("PTY session is not writable."));
      },
      resize: (cols: number, rows: number) => controllerRef.current?.resize(cols, rows),
    }),
    [sessionId, status, mode, reattached],
  );
}

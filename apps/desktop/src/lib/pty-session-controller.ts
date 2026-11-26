import {
  adoptPtySession,
  adoptRemotePtySession,
  createCommandPtySession,
  createRemotePtySession,
  createPtySession,
  killPtySession,
  writeToSession,
  resizeSession,
  listPtySessions,
  reconcilePtySessions,
} from "@/lib/tauri-api";
import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";
import { buildSshCommand, parseSshArgv, type SshTarget } from "@/modules/codespace/services/ssh-command";
import { remoteArgv } from "@/modules/codespace/services/ssh-argv";
import { remoteCallbackEnv } from "@/lib/remote-callback";

/**
 * The machine a session runs on, or null for this one.
 *
 * A remote session is a perfectly ordinary local PTY whose child happens to be `ssh` — the pattern
 * that survived when `src-tauri/src/pty_ssh.rs` was pruned in `067eca6d`. Nothing below this seam
 * knows the difference, which is the point: reattach, scrollback, resize and kill keep working
 * because there is still exactly one kind of session.
 */
function sshTargetOf(location?: CodeSpaceStoredWorkspaceLocation | null): SshTarget | null {
  if (!location || location.kind !== "ssh") return null;
  return {
    host: location.host,
    ...(location.user ? { user: location.user } : {}),
    ...(location.port ? { port: location.port } : {}),
  };
}

/**
 * The local working directory for the `ssh` client itself.
 *
 * Empty on purpose: a remote project's `cwd` is a path on the OTHER machine, and handing it to
 * `portable_pty` as the child's working directory would either fail to spawn or — worse — land in a
 * local directory that happens to share the path. Rust reads an empty cwd as the user's home
 * (`pty.rs::resolve_session_cwd`), and the real directory is carried inside the ssh command.
 */
const SSH_CLIENT_CWD = "";

/**
 * Shown once in a pane on a machine without a Lotus host: its process lives under `ssh -t`, so a
 * dropped link still ends it (plans/ssh-pane-durability, decision 2).
 */
export const NO_REMOTE_DAEMON_NOTICE =
  "\x1b[2m[Lotus] This machine runs no Lotus host, so this pane is a plain SSH session: if the link drops, its process ends.\x1b[0m\r\n";

/** Tracks all active controllers for orphan reaping */
const activeControllers = new Set<PtySessionController>();

export class PtySessionController {
  private ptyId: string | null = null;
  private aborted = false;
  private pendingSpawn: Promise<string> | null = null;
  private pendingKill: Promise<void> | null = null;
  private lastResize: { sessionId: string; cols: number; rows: number } | null = null;
  /**
   * A size asked for before the PTY has an id. The pane is usually fitted while the spawn is still
   * in flight; dropping that size leaves the PTY at its spawn geometry while the renderer draws at
   * the fitted one, and every later fit at the same size is deduped away, so it never heals.
   */
  private pendingResize: { cols: number; rows: number } | null = null;
  /** The PTY was found running (session daemon), not started: the caller must not launch into it. */
  private adopted = false;

  /**
   * The Claude account this session runs on (issues/07); null = the globally chosen one. Local
   * spawns only: an account id names a dir on this machine.
   * shortcut: an SSH session ignores it, until the host takes an account on PTY spawns (slice B).
   */
  constructor(private readonly claudeAccount: string | null = null) {}

  async connect(
    cwd: string,
    cols: number,
    rows: number,
    onOutput: (data: string) => void,
    paneId?: string,
    location?: CodeSpaceStoredWorkspaceLocation | null,
    canvasTerminalId?: string,
  ): Promise<void> {
    if (this.aborted) return;
    const target = sshTargetOf(location);
    if (target) {
      // A shell on another machine: `ssh -t <target> "cd <cwd> && exec $SHELL -l"`, built by the
      // one function that already owns that string.
      const argv = buildSshCommand({ target, remoteCwd: cwd });
      return this.connectToCommand(SSH_CLIENT_CWD, argv, cols, rows, onOutput, paneId, location, canvasTerminalId);
    }
    activeControllers.add(this);

    const guardedOnOutput = (data: string) => {
      if (this.aborted) return;
      onOutput(data);
    };

    if (paneId) {
      if (await this.tryAdopt(paneId, guardedOnOutput)) return;
      if (this.aborted) {
        // Closed while we looked for a session to adopt: nothing was started, so nothing to kill.
        activeControllers.delete(this);
        return;
      }
    }

    try {
      this.pendingSpawn = createPtySession(cwd, cols, rows, guardedOnOutput, paneId, canvasTerminalId, this.claudeAccount);
      this.ptyId = await this.pendingSpawn;
      this.adoptSpawnGeometry(cols, rows);
    } catch (err) {
      activeControllers.delete(this);
      if (!this.aborted) throw err;
      return;
    } finally {
      this.pendingSpawn = null;
    }

    // KEY: If abort() was called while we were awaiting, kill immediately
    if (this.aborted) {
      await this.abortConfirmed();
    }
  }

  /**
   * Direct (shell-less) spawn with graceful degradation: run `argv` as the PTY child — skipping
   * the login shell + typed-command hop that costs a live agent its first seconds — and fall back
   * to a plain shell session when the direct spawn fails (unresolvable binary, shell-function
   * runner) or no argv was given. Returns which mode ended up live so the launch controller knows
   * whether it still has to type the command.
   */
  async connectPreferCommand(
    cwd: string,
    argv: string[] | null | undefined,
    cols: number,
    rows: number,
    onOutput: (data: string) => void,
    paneId?: string,
    canvasTerminalId?: string,
    location?: CodeSpaceStoredWorkspaceLocation | null,
  ): Promise<"command" | "shell"> {
    if (argv && argv.length > 0) {
      try {
        await this.connectToCommand(cwd, argv, cols, rows, onOutput, paneId, location, canvasTerminalId);
        return "command";
      } catch (err) {
        if (this.isAborted()) throw err;
        console.warn("[pty] direct spawn failed — falling back to shell:", err);
      }
    }
    await this.connect(cwd, cols, rows, onOutput, paneId, location, canvasTerminalId);
    return "shell";
  }

  async connectToCommand(
    cwd: string,
    command: string[],
    cols: number,
    rows: number,
    onOutput: (data: string) => void,
    paneId?: string,
    location?: CodeSpaceStoredWorkspaceLocation | null,
    canvasTerminalId?: string,
  ): Promise<void> {
    // A command that is itself `ssh` (Code's SSH workspace cells store one) already reaches the far
    // machine; wrapping it again runs `ssh <host>` ON that machine, where the alias does not resolve.
    const alreadyRemote = command[0] === "ssh" && sshTargetOf(location) !== null;
    const target = alreadyRemote ? null : sshTargetOf(location);
    // The runner's argv crosses SSH through the one quoting seam (`ssh-argv.ts`); the ssh client
    // itself starts in the user's home, because `cwd` names a directory on the far machine.
    //
    // The callback environment rides with it: a remote agent's hooks have no other way to learn
    // which pane they belong to or how to reach this desktop, and putting it on that machine's disk
    // would leave a credential behind after the session.
    const callbackEnv = target ? await remoteCallbackEnv(paneId) : undefined;
    if (this.aborted) return;
    const spawnArgv = target ? remoteArgv({ kind: "ssh", ...target }, command, cwd, callbackEnv) : command;
    const spawnCwd = target || alreadyRemote ? SSH_CLIENT_CWD : cwd;
    activeControllers.add(this);

    const guardedOnOutput = (data: string) => {
      if (this.aborted) return;
      onOutput(data);
    };

    if (paneId) {
      if (await this.tryAdopt(paneId, guardedOnOutput)) return;
      if (this.aborted) {
        // Closed while we looked for a session to adopt: nothing was started, so nothing to kill.
        activeControllers.delete(this);
        return;
      }
    }

    // On another machine, the process goes into that machine's session daemon when it runs one:
    // there a dropped link only pauses the pane, under `ssh -t` it kills the agent.
    // Code cells and Canvas nodes store the `ssh -t` argv they built; it is read back here, and
    // the machine comes from that argv, since a Canvas node passes no location.
    const parsed = parseSshArgv(spawnArgv);
    const machine = parsed?.target;
    const remoteCommand = parsed?.remoteCommand;
    if (machine && remoteCommand) {
      const placed = await this.tryRemoteDaemon(machine, remoteCommand, cols, rows, guardedOnOutput, paneId, canvasTerminalId);
      if (placed === "running") return;
      if (this.aborted) {
        activeControllers.delete(this);
        return;
      }
      if (placed === "no-daemon") guardedOnOutput(NO_REMOTE_DAEMON_NOTICE);
    }

    try {
      this.pendingSpawn = createCommandPtySession(
        spawnCwd,
        spawnArgv,
        cols,
        rows,
        guardedOnOutput,
        paneId,
        canvasTerminalId,
        target || alreadyRemote ? null : this.claudeAccount,
      );
      this.ptyId = await this.pendingSpawn;
      this.adoptSpawnGeometry(cols, rows);
    } catch (err) {
      activeControllers.delete(this);
      if (!this.aborted) throw err;
      return;
    } finally {
      this.pendingSpawn = null;
    }

    if (this.aborted) {
      await this.abortConfirmed();
    }
  }

  /**
   * Takes over the pane's session if the session daemon still runs one. Its size is the old
   * pane's, so no resize is recorded: the next fit goes through and makes the program redraw.
   */
  private async tryAdopt(paneId: string, onOutput: (data: string) => void): Promise<boolean> {
    let id: string | null = null;
    try {
      this.pendingSpawn = adoptPtySession(paneId, onOutput).then((found) => found ?? "");
      id = (await this.pendingSpawn) || null;
    } catch (err) {
      console.warn("[pty] adopt failed — starting a new session:", err);
    } finally {
      this.pendingSpawn = null;
    }
    if (!id) return false;
    this.ptyId = id;
    this.adopted = true;
    this.lastResize = null;
    const wanted = this.pendingResize;
    this.pendingResize = null;
    if (wanted) this.resize(wanted.cols, wanted.rows);
    if (this.aborted) await this.abortConfirmed();
    return true;
  }

  /**
   * Puts the pane in `machine`'s session daemon: its own session from before if one is there,
   * else a new one. `"no-daemon"` / `"failed"` = run it under `ssh -t` as before; a failure never
   * leaves the pane without a terminal.
   */
  private async tryRemoteDaemon(
    machine: SshTarget,
    remoteCommand: string,
    cols: number,
    rows: number,
    onOutput: (data: string) => void,
    paneId?: string,
    canvasTerminalId?: string,
  ): Promise<"running" | "no-daemon" | "failed"> {
    let id: string | null = null;
    let adopted = false;
    try {
      if (paneId) {
        this.pendingSpawn = adoptRemotePtySession(machine, paneId, onOutput).then((found) => found ?? "");
        id = (await this.pendingSpawn) || null;
        adopted = id !== null;
      }
      if (!id && !this.aborted) {
        let noDaemon = false;
        this.pendingSpawn = createRemotePtySession(machine, remoteCommand, cols, rows, onOutput, paneId, canvasTerminalId)
          .then((created) => {
            noDaemon = created === null;
            return created ?? "";
          });
        id = (await this.pendingSpawn) || null;
        if (noDaemon) return "no-daemon";
      }
    } catch (err) {
      console.warn("[pty] remote session daemon unavailable — using ssh -t:", err);
      return "failed";
    } finally {
      this.pendingSpawn = null;
    }
    if (!id) return "failed";
    this.ptyId = id;
    if (adopted) {
      this.adopted = true;
      this.lastResize = null;
      const wanted = this.pendingResize;
      this.pendingResize = null;
      if (wanted) this.resize(wanted.cols, wanted.rows);
    } else {
      this.adoptSpawnGeometry(cols, rows);
    }
    if (this.aborted) await this.abortConfirmed();
    return "running";
  }

  wasAdopted(): boolean {
    return this.adopted;
  }

  abort(): void {
    void this.abortConfirmed().catch((err) => console.warn("[pty-guard] kill failed:", err));
  }

  /** Explicit close waits for native acknowledgement; failed kills retain the id for retry. */
  abortConfirmed(): Promise<void> {
    this.aborted = true;
    if (this.pendingKill) return this.pendingKill;
    if (this.ptyId) {
      const sessionId = this.ptyId;
      this.pendingKill = killPtySession(sessionId).then(() => {
        this.ptyId = null;
        this.lastResize = null;
        activeControllers.delete(this);
      }).finally(() => { this.pendingKill = null; });
      return this.pendingKill;
    }
    if (this.pendingSpawn) {
      return this.pendingSpawn.then(() => this.abortConfirmed(), () => undefined);
    }
    return Promise.resolve();
  }

  /** Fire-and-forget input path used by interactive terminal typing. */
  write(data: string): void {
    if (!this.ptyId || this.aborted) return;
    const sessionId = this.ptyId;
    void this.writeConfirmed(data).catch((err) => {
      console.warn(`[pty] write failed for session ${sessionId}:`, err);
    });
  }

  /** Receipt-bearing write path for submissions that must confirm native PTY acceptance. */
  writeConfirmed(data: string): Promise<void> {
    if (!this.ptyId || this.aborted) {
      return Promise.reject(new Error("PTY session is not writable."));
    }
    return writeToSession(this.ptyId, data);
  }

  resize(cols: number, rows: number): void {
    if (this.aborted) return;
    if (!this.ptyId) {
      this.pendingResize = { cols, rows };
      return;
    }
    const last = this.lastResize;
    if (last?.sessionId === this.ptyId && last.cols === cols && last.rows === rows) return;
    const sent = { sessionId: this.ptyId, cols, rows };
    this.lastResize = sent;
    resizeSession(sent.sessionId, cols, rows).catch((err) => {
      console.warn(`[pty] resize failed for session ${sent.sessionId}:`, err);
      // Not applied, so not deduped: the next fit at this size has to try again.
      if (this.lastResize === sent) this.lastResize = null;
    });
  }

  /** Records the size the PTY was spawned at, then applies any size asked for while it spawned. */
  private adoptSpawnGeometry(cols: number, rows: number): void {
    this.lastResize = this.ptyId ? { sessionId: this.ptyId, cols, rows } : null;
    const wanted = this.pendingResize;
    this.pendingResize = null;
    if (wanted) this.resize(wanted.cols, wanted.rows);
  }

  getSessionId(): string | null {
    return this.aborted ? null : this.ptyId;
  }

  isAborted(): boolean {
    return this.aborted;
  }
}

/**
 * After a window restored its workspaces: ends the session-daemon sessions whose pane is no
 * longer in any of them. Runs after the restore, never before — before it, every pane looks gone.
 */
export async function reconcileSessions(paneIds: string[]): Promise<void> {
  try {
    const ended = await reconcilePtySessions(paneIds);
    if (ended > 0) console.info(`[pty] ended ${ended} session(s) whose pane is gone`);
  } catch (err) {
    console.warn("[pty] reconcile failed:", err);
  }
}

/**
 * Kills any PTY sessions the Rust backend knows about that no active
 * controller is tracking. Call on app startup for crash recovery.
 */
export async function reapOrphanedSessions(): Promise<void> {
  try {
    const rustSessions = await listPtySessions();
    const trackedIds = new Set<string>();
    for (const ctrl of activeControllers) {
      const id = ctrl.getSessionId();
      if (id) trackedIds.add(id);
    }
    for (const session of rustSessions) {
      if (!trackedIds.has(session.id)) {
        await killPtySession(session.id).catch((err) =>
          console.warn("[pty-guard] reap failed:", session.id, err)
        );
      }
    }
  } catch {
    // listPtySessions may fail if not in Tauri — safe to ignore
  }
}

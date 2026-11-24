import { createLogger, type Logger } from "../../core/logger.js";
import { PtyManager } from "./manager.js";
import { selectPtyBackendKind } from "./backend-choice.js";
import { adoptableSessions, attachSessiondSession, createSessiondSpawnFn, type SessiondPort } from "./sessiond-backend.js";
import { connectOrSpawnSessiond, resolveSessiondBinary, sessiondSocketPath, type SessiondClient } from "./sessiond-client.js";

export interface PtyRuntime {
  manager: PtyManager;
  /** Releases the daemon connection. Session lifetime is `PtyManager.stop`'s call. */
  stop(): void;
}

export type DaemonConnection = SessiondPort & Pick<SessiondClient, "list" | "close">;

export interface PtyRuntimeOptions {
  mode: "client" | "standalone";
  env: { LOTUS_PTY?: string | undefined };
  /** Where each session's durable scrollback is written. */
  logDir: string;
  /** The daemon's socket, extracted binary and stderr log. */
  sessiondDir: string;
  /** LOTUS_SESSIOND_BIN: a daemon binary to run instead of the embedded one. */
  sessiondBin?: string;
  logger?: Logger;
  /** Seam for the tests; production connects to the daemon, spawning it when none listens. */
  connectSessiond?: () => Promise<DaemonConnection>;
}

export async function createPtyRuntime(opts: PtyRuntimeOptions): Promise<PtyRuntime> {
  const log = opts.logger ?? createLogger();
  const { kind } = selectPtyBackendKind({ mode: opts.mode, env: opts.env });

  if (kind === "node-pty") {
    if (opts.mode === "standalone") log.warn("pty.durability_unavailable", { reason: "LOTUS_PTY=node-pty: sessions die with the host" });
    // Loaded here so the native addon never loads in a build that does not use it.
    const { spawn } = await import("node-pty");
    return { manager: new PtyManager(spawn), stop: () => undefined };
  }

  const connect = opts.connectSessiond ?? (() => {
    const socket = sessiondSocketPath(opts.sessiondDir, process.getuid?.() ?? 0);
    return connectOrSpawnSessiond(socket, () => resolveSessiondBinary(opts.sessiondDir, opts.sessiondBin));
  });
  let current: Promise<DaemonConnection> | undefined;
  const client = (): Promise<DaemonConnection> => {
    if (current === undefined) {
      const attempt = connect();
      current = attempt;
      const forget = () => {
        if (current === attempt) current = undefined;
      };
      attempt.then((c) => c.onClose(forget), forget);
    }
    return current;
  };

  let first: DaemonConnection;
  try {
    first = await client();
  } catch (error) {
    throw new Error(
      `Refusing to start: lotus-sessiond is unavailable (${String(error)}). Without it no session ` +
      "would survive a host restart, which is what this deployment exists to prevent. " +
      "Set LOTUS_PTY=node-pty to accept that loss.",
    );
  }

  let stopping = false;
  const deps = { client, logDir: opts.logDir, isStopping: () => stopping, onError: (id: string, error: unknown) => log.warn("pty.sessiond_failed", { id, error: String(error) }) };
  const known = new Map<string, string>();
  const manager = new PtyManager(createSessiondSpawnFn(deps), (id) => attachSessiondSession(id, known.get(id) ?? id, deps));

  const found = adoptableSessions(await first.list(), (daemonId) => log.warn("pty.adopt_skipped", { daemonId, reason: "no host tag" }));
  for (const s of found) {
    known.set(s.sessionId, s.daemonId);
    try {
      manager.adopt(s.sessionId, s.opts);
    } catch (error) {
      log.warn("pty.adopt_skipped", { id: s.sessionId, error: String(error) });
    }
  }
  if (found.length > 0) log.info("pty.adopted", { count: found.length });

  return {
    manager,
    stop: () => {
      stopping = true;
      void current?.then((c) => c.close(), () => undefined);
    },
  };
}

import type { ApiClient } from "../../core/api-client.js";
import type { Logger } from "../../core/logger.js";
import type { MobileHostIdentity } from "./http-routes.js";
import type { PushSender } from "./push/fcm-sender.js";
import type { SessionHistoryDiagnostics } from "./session-history-diagnostics.js";

export interface MobileAdapterOptions {
  api: ApiClient;
  logger: Logger;
  host: MobileHostIdentity;
  /** Where the façade listens. Port 0 asks the OS for a free port. */
  bind: { host: string; port: number };
  /** Path to the persisted device credentials. */
  devicesPath: string;
  /** Where Chat cells are saved to survive a host restart. Absent: they do not. */
  structuredCellsPath?: string;
  /** Copies of Chat Attachments sent from another machine (ADR-0069). Absent: `send` refuses them. */
  attachmentsDir?: string;
  fleetPollMs?: number;
  /** Fase 0 measurement (plans/session-history-hardening/issues/01); absent disables it. */
  sessionHistoryDiagnostics?: SessionHistoryDiagnostics;
  /** Loopback control channel for the desktop. Absent means no admin surface at all. */
  admin?: { secret: string; advertPath: string };

  /**
   * What can ring a phone whose socket is closed (ADR-4). Absent means this host
   * cannot push — an ordinary deployment, not a fault, and `hostCaps` says so rather
   * than leaving the app to register a token that will never be used.
   *
   * A sender rather than a `PushService`: the device store is built here, so this is
   * the only place the two can be joined without one arriving half-built.
   */
  pushSender?: PushSender;

  /** Injected so a test can drive the notification reconnect without real delay. */
  sleep?: (ms: number) => Promise<void>;

  /** Force structured spawn on or off; default is whether `codex` is on PATH. */
  structuredSpawn?: boolean;

  /** Whether an agent hook is installed, which is what makes TUI `permission` observable. */
  hooks?: boolean;

  /**
   * Whether the host behind this façade has a workspace root to clone repositories into.
   * Absent means `POST /m/projects/clone` would answer 503, and the flag stays off so the
   * phone draws no door.
   */
  projectsCreate?: boolean;

  /**
   * Whether the host behind this façade opens any directory for browsing and will take one
   * as a project. Absent means `GET /m/fs` answers 503, and the phone draws no folder picker.
   */
  projectsBrowse?: boolean;
}

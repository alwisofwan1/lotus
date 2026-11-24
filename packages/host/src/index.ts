/**
 * lotus-remote — entry point
 *
 * Usage:
 *   bun run dev          # auto-loads .env from cwd
 *
 * LOTUS_MODE=client (default): delegates all API calls to a running Lotus desktop app.
 * LOTUS_MODE=standalone: starts an embedded Standalone Host before connecting the adapter.
 */
import { loadEnv } from "./core/load-env.js";
loadEnv(); // must run before any module reads process.env

import { homedir } from "node:os";
import { join } from "node:path";

import { ApiClient } from "./core/api-client.js";
import { CHAT_ATTACHMENTS_DIR } from "./core/chat-attachments.js";
import { loadConfig, type AppConfig } from "./core/config.js";
import { startupWarnings } from "./core/startup-warnings.js";
import { createLogger } from "./core/logger.js";
import { resolveStateDir } from "./core/state-dir.js";
import type { RemoteAdapter } from "./types/index.js";

import { APPROVAL_SERVER_FLAG } from "./adapters/mobile/structured/bridges/claude/approval-script.js";
import type { StructuredFleetRef } from "./server/structured-fleet-ref.js";

const logger = createLogger();

async function main(): Promise<void> {
  // **Before anything that reads configuration.** `claude` spawns this same executable as the
  // approval MCP server (`--mcp-config`), and that child has no API key, no host and no
  // business starting one — it speaks JSON-RPC on stdio and dials a unix socket. Placed first
  // because the old shape died exactly here: the compiled binary ignored the script it was
  // handed, fell through to `loadConfig()`, and exited with "Lotus API key not found" — so the
  // tool never registered and every approval was refused rather than asked (issue 26 of
  // `plans/pocket-without-laptop`).
  if (process.argv.includes(APPROVAL_SERVER_FLAG)) {
    const { runApprovalServer } = await import(
      "./adapters/mobile/structured/bridges/claude/approval-server.js"
    );
    runApprovalServer({
      input: process.stdin,
      output: process.stdout,
      socketPath: process.env["LOTUS_APPROVAL_SOCKET"],
    });
    return;
  }

  const mode = process.env["LOTUS_MODE"] ?? "client";

  if (mode === "standalone") {
    await startStandalone();
  } else {
    await startClient();
  }
}

async function startStandalone(): Promise<void> {
  // Said at boot, before anything else scrolls past: a VPS has nobody watching, so a host that
  // cannot wake a phone looks exactly like a host where nothing is happening.
  // `requireApiKey: false` — this host is about to mint its own; see `LoadConfigOptions`.
  const config = loadConfig({ requireApiKey: false });

  for (const warning of startupWarnings({
    mode: "standalone",
    fcmServiceAccountPath: config.fcmServiceAccountPath,
  })) {
    logger.warn("startup.degraded", { detail: warning });
  }

  const { createStandaloneHost } = await import("./server/index.js");
  const host = await createStandaloneHost();

  const adapter = process.env["ADAPTER"] ?? "mobile";
  const client = new ApiClient(host.url, host.apiKey);

  // What the host could actually install decides what it advertises — a permission this host
  // cannot observe is one it must not promise (slice 1b).
  const remoteAdapter = await resolveAdapter(adapter, client, config, {
    hooks: host.hooksInstalled,
    projectsCreate: host.canCloneProjects,
    projectsBrowse: host.canBrowseProjects,
  }, host.structuredFleet);

  const shutdown = async (): Promise<void> => {
    // First, so desktop streams end quietly instead of reading the closing cells as ended.
    host.structuredFleet.close();
    await remoteAdapter.stop();
    await host.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await remoteAdapter.start();
}

async function startClient(): Promise<void> {
  const config = loadConfig();

  const client = new ApiClient(config.baseUrl, config.apiKey);
  try {
    const health = await client.health();
    logger.info("lotus.api.reachable", { version: health.version, port: health.port });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("lotus.api.unreachable", { error: msg, hint: "Make sure the Lotus desktop app is running." });
  }

  const adapter = await resolveAdapter(config.adapter, client, config);
  logger.info("adapter.starting", { adapter: adapter.name });

  const shutdown = async (): Promise<void> => {
    logger.info("shutdown.begin");
    await adapter.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await adapter.start();
}

/**
 * Resolves an adapter by name.
 *
 * The Telegram adapter was removed on 2026-08-02 (ADR-2), and the mobile façade
 * that replaces it lands next (ADR-10). Until then there is deliberately **no**
 * adapter rather than a stub that pretends to be one — the failure is loud and
 * says exactly what is missing.
 *
 * `LOTUS_MODE=standalone` still starts the Standalone Host, so the PTY/agent
 * runtime remains usable and testable without any adapter attached.
 */
async function resolveAdapter(
  name: string,
  client: ApiClient,
  config: AppConfig,
  capabilities: { hooks?: boolean; projectsCreate?: boolean; projectsBrowse?: boolean } = {},
  /**
   * Where the standalone server reads this adapter's headless cells from.
   *
   * Bound here rather than at the call site because that one holds a `RemoteAdapter`, and
   * only this function still sees the concrete `MobileAdapter` that owns them.
   */
  structuredFleet?: StructuredFleetRef,
): Promise<RemoteAdapter> {
  if (name !== "mobile") {
    throw new Error(`Unknown adapter "${name}". Available adapters: mobile`);
  }
  const { MobileAdapter } = await import("./adapters/mobile/index.js");
  const admin = adminConfig();
  const pushSender = await buildPushSender(config);
  const sessionHistoryDiagnostics = await buildSessionHistoryDiagnostics();
  const adapter = new MobileAdapter({
    api: client,
    logger,
    host: {
      hostId: config.hostLabel,
      hostLabel: config.hostLabel,
      mode: process.env["LOTUS_MODE"] === "standalone" ? "standalone" : "client",
    },
    bind: config.mobileBind,
    devicesPath: join(stateDir(), "mobile-devices.json"),
    structuredCellsPath: join(stateDir(), "structured-cells.json"),
    attachmentsDir: join(stateDir(), CHAT_ATTACHMENTS_DIR),
    // Spread rather than `admin: adminConfig()`: under exactOptionalPropertyTypes
    // an explicit `undefined` is not the same as an absent key.
    ...(admin === undefined ? {} : { admin }),
    ...(pushSender === undefined ? {} : { pushSender }),
    ...(sessionHistoryDiagnostics === undefined ? {} : { sessionHistoryDiagnostics }),
    ...(capabilities.hooks === true ? { hooks: true } : {}),
    ...(capabilities.projectsCreate === true ? { projectsCreate: true } : {}),
    ...(capabilities.projectsBrowse === true ? { projectsBrowse: true } : {}),
  });
  // Now that both halves exist, tell the `/v1/*` server where this adapter's headless cells
  // are — without it, `POST /v1/list-fleet` reports only the cells that have a terminal.
  structuredFleet?.bind({
    ready: () => adapter.structuredReady(),
    list: (workspaceId) => adapter.structuredFleet(workspaceId),
    page: (paneId) => adapter.structuredPage(paneId),
    since: (paneId, cursor) => adapter.conversationSince(paneId, cursor),
    subscribe: (listener) => adapter.onConversation(listener),
    act: (action, body) => adapter.chatAct(action, body),
  });
  return adapter;
}

/**
 * Fase 0 measurement only (plans/session-history-hardening) — counts polls, bytes,
 * truncation and read failures per pane so retention limits get set from real numbers
 * instead of another guess (ADR-3).
 *
 * `LOTUS_DIAGNOSTICS=0` is the same switch the desktop layer reads. One measurement
 * spans three processes, so one name turns all of it off — an operator should not have
 * to learn a second variable to silence the same run.
 */
async function buildSessionHistoryDiagnostics() {
  if (process.env["LOTUS_DIAGNOSTICS"] === "0") return undefined;
  const { SessionHistoryDiagnostics } = await import(
    "./adapters/mobile/session-history-diagnostics.js"
  );
  return new SessionHistoryDiagnostics({
    path: join(stateDir(), "diagnostics", "session-history.jsonl"),
  });
}

/**
 * The thing that can ring a phone, if this host is configured to (ADR-4).
 *
 * A *sender*, not a whole service: the device store lives inside `MobileAdapter`, so
 * the adapter is the only place that can pair the two without one of them being handed
 * in half-built. This function owns exactly what belongs at the process boundary —
 * reading a key path from config, and turning `fetch` into the two narrow seams the
 * push modules take.
 *
 * Undefined is a normal outcome, not a failure: a host with no Firebase service
 * account cannot push, and `hostCaps` reports that instead of leaving the app to
 * register a token nothing will ever use. A *malformed* account file is different and
 * throws from `FcmCredentials.load` — that is a misconfiguration the operator intended
 * to work, and failing quietly there is how a silent channel is born.
 */
async function buildPushSender(config: AppConfig) {
  const { FcmCredentials, resolveServiceAccountPath } = await import(
    "./adapters/mobile/push/fcm-credentials.js"
  );
  // The state dir, unless the env names somewhere else — see `resolveServiceAccountPath`
  // for why an env var alone cannot configure this on a desktop install.
  const accountPath = resolveServiceAccountPath(config.fcmServiceAccountPath, stateDir());
  const credentials = FcmCredentials.load(accountPath, {
    fetchToken: async (uri, body) => {
      const res = await fetch(uri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      return { status: res.status, text: await res.text() };
    },
    warn: (message) => logger.warn("mobile.push.key_permissions", { message }),
  });
  if (credentials === null) {
    logger.info("mobile.push.disabled", { reason: `no service account at ${accountPath}` });
    return undefined;
  }

  const { FcmSender } = await import("./adapters/mobile/push/fcm-sender.js");
  logger.info("mobile.push.enabled", { projectId: credentials.account.projectId });

  return new FcmSender(credentials, async (uri, init) => {
    const res = await fetch(uri, { method: "POST", headers: init.headers, body: init.body });
    return { status: res.status, text: await res.text() };
  });
}

/** Where credentials live. Rust passes its resolved profile dir; see `resolveStateDir`. */
function stateDir(): string {
  return resolveStateDir(process.env, homedir());
}

/**
 * Admin channel config, or undefined when this host was not spawned by Lotus.
 *
 * Undefined is the correct answer for a hand-run host: no secret means no way to
 * authenticate the channel, and an unauthenticated one would be reachable by
 * every local process.
 */
function adminConfig(): { secret: string; advertPath: string } | undefined {
  const secret = process.env["LOTUS_MOBILE_ADMIN_SECRET"]?.trim();
  if (secret === undefined || secret.length === 0) return undefined;
  return { secret, advertPath: join(stateDir(), "mobile-admin.json") };
}

main().catch((err) => {
  logger.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

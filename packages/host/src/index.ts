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
  // Start approval MCP before config loading because its stdio subprocess has no host API key (issue 26, plans/pocket-without-laptop).
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

/** Standalone runtime can start without an adapter (ADR-2, ADR-10). */
async function resolveAdapter(
  name: string,
  client: ApiClient,
  config: AppConfig,
  capabilities: { hooks?: boolean; projectsCreate?: boolean; projectsBrowse?: boolean } = {},
  /** Bind here while the concrete adapter that owns the cells is still available. */
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

/** Share LOTUS_DIAGNOSTICS with the desktop so one switch controls all probes (ADR-3, plans/session-history-hardening). */
async function buildSessionHistoryDiagnostics() {
  if (process.env["LOTUS_DIAGNOSTICS"] === "0") return undefined;
  const { SessionHistoryDiagnostics } = await import(
    "./adapters/mobile/session-history-diagnostics.js"
  );
  return new SessionHistoryDiagnostics({
    path: join(stateDir(), "diagnostics", "session-history.jsonl"),
  });
}

/** Only advertise push when credentials are configured, and surface malformed credentials as a configuration error (ADR-4). */
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

/** Require a secret so other local processes cannot use an unauthenticated admin channel. */
function adminConfig(): { secret: string; advertPath: string } | undefined {
  const secret = process.env["LOTUS_MOBILE_ADMIN_SECRET"]?.trim();
  if (secret === undefined || secret.length === 0) return undefined;
  return { secret, advertPath: join(stateDir(), "mobile-admin.json") };
}

main().catch((err) => {
  logger.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

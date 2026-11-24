import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import type { ApiServerDiscovery } from "../types/index.js";

export interface AppConfig {
  /** Base URL of the Lotus HTTP API, e.g. "http://127.0.0.1:9877" */
  baseUrl: string;
  /** Bearer token for the HTTP API */
  apiKey: string;
  /** Active adapter name, defaults to "mobile" (ADR-10). */
  adapter: string;
  /** Where the mobile façade listens — `LOTUS_MOBILE_BIND`, default localhost. */
  mobileBind: { host: string; port: number };
  /** Label the operator sees for this host in Pocket. */
  hostLabel: string;

  /**
   * Path to the Firebase **service account** JSON that authorises FCM sends
   * (`LOTUS_FCM_SERVICE_ACCOUNT`). Undefined means this host cannot wake a
   * backgrounded app, and `hostCaps` will not claim otherwise (ADR-4).
   *
   * A path read at the config boundary rather than inside the sender, because the
   * inherited rule is that no class reads `process.env` itself — and because this is
   * the one value here that points at private key material.
   */
  fcmServiceAccountPath: string | undefined;
}

/**
 * Loads runtime config from (in order):
 *  1. `~/.lotus/api-server.json` (canonical discovery file written by Lotus)
 *  2. `~/.lotus-dev/api-server.json` (dev-profile discovery)
 *  3. `~/.claude/api-server.json` (legacy fallback for pre-migration installs)
 *  4. `~/.lotus/api-server.key` → `~/.claude/api-server.key` (key fallback)
 *  5. Env vars: `LOTUS_API_URL`, `LOTUS_API_KEY`, `ADAPTER`
 *
 * Env vars always win over the discovery file, making it easy to override
 * in CI or when running the bot on a different machine.
 */
export interface LoadConfigOptions {
  /**
   * Whether a missing key is fatal. True for client mode, where the key is the only
   * way to reach the desktop's API and a host without one can do nothing.
   *
   * A standalone host mints its own key in `server/index.ts` and hands it straight to
   * `ApiClient`, so nothing here is ever read for it. Left required, a clean VPS — no
   * `~/.lotus/api-server.json`, no desktop that could have written one — crashes at boot
   * with "Start the Lotus app", which is advice for a machine that by definition has none.
   */
  requireApiKey?: boolean;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const candidateRoots = [
    join(homedir(), ".lotus"),
    join(homedir(), ".lotus-dev"),
    join(homedir(), ".claude"),
  ];
  let port = 9877;
  let apiKey = "";

  for (const root of candidateRoots) {
    const discovered = tryReadDiscovery(root);
    if (discovered !== null) {
      port = discovered.port;
      apiKey = discovered.apiKey;
      break;
    }
  }

  if (!apiKey) {
    // Discovery file absent (Lotus not started yet) — fall back to bare key file
    for (const root of candidateRoots) {
      const key = tryReadKeyFile(join(root, "api-server.key"));
      if (key !== null) {
        apiKey = key;
        break;
      }
    }
  }

  // Env vars override everything
  const baseUrl = process.env["LOTUS_API_URL"] ?? `http://127.0.0.1:${port}`;
  const keyOverride = process.env["LOTUS_API_KEY"];
  if (keyOverride) apiKey = keyOverride;

  if (!apiKey && options.requireApiKey !== false) {
    throw new Error(
      "Lotus API key not found. Start the Lotus app or set LOTUS_API_KEY env var."
    );
  }

  const adapter = process.env["ADAPTER"] ?? "mobile";
  const mobileBind = parseBind(process.env["LOTUS_MOBILE_BIND"]);
  const hostLabel = process.env["LOTUS_HOST_LABEL"] ?? hostname();

  const fcmServiceAccountPath = trimmedEnv("LOTUS_FCM_SERVICE_ACCOUNT");

  return { baseUrl, apiKey, adapter, mobileBind, hostLabel, fcmServiceAccountPath };
}

/** An env var that is set but blank means "not configured", not "configured as empty". */
function trimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function tryReadDiscovery(root: string): { port: number; apiKey: string } | null {
  try {
    const raw = readFileSync(join(root, "api-server.json"), "utf8");
    const discovery = JSON.parse(raw) as ApiServerDiscovery;
    const apiKey = readFileSync(discovery.keyFile, "utf8").trim();
    if (!apiKey) return null;
    return { port: discovery.port, apiKey };
  } catch {
    return null;
  }
}

function tryReadKeyFile(path: string): string | null {
  try {
    const trimmed = readFileSync(path, "utf8").trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

/** Parses `host:port`, falling back to localhost so a typo cannot expose the host. */
function parseBind(raw: string | undefined): { host: string; port: number } {
  const fallback = { host: "127.0.0.1", port: 8787 };
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const at = raw.lastIndexOf(":");
  if (at <= 0) return fallback;
  const port = Number(raw.slice(at + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65_535) return fallback;
  return { host: raw.slice(0, at), port };
}

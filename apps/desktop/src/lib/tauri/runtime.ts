// Lazy-load Tauri APIs so the module only executes in the browser (never on the
// Node.js prerender path). serverExternalPackages in next.config.ts keeps
// @tauri-apps/api out of the server bundle; Turbopack bundles it as a lazy
// client chunk so Tauri's WebView can resolve the specifier at runtime.
export async function loadTauriCore() {
  return import("@tauri-apps/api/core");
}

/**
 * Returns true when running inside the Tauri desktop app (IPC bridge present).
 * Returns false in plain browser / `npm run dev` / Next.js SSR context.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isTauriCancelationError(error: unknown): boolean {
  if (typeof error === "string") {
    return error.toLowerCase().includes("operation is manually canceled");
  }

  if (typeof error !== "object" || error === null) return false;

  const record = error as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const message = [record.msg, record.message, record.name]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();

  return type === "cancelation"
    || type === "cancellation"
    || message.includes("operation is manually canceled")
    || message.includes("aborterror");
}

// REST fallback map — used when running in browser (npm run dev) instead of Tauri desktop.
// Path templates use {param} syntax; matched keys are removed from the request body.
const REST_MAP: Record<string, { path: string; method?: string }> = {
  list_teams:     { path: "/api/teams" },
  get_team:       { path: "/api/teams/{id}" },
  create_team:    { path: "/api/teams", method: "POST" },
  update_team:    { path: "/api/teams/{id}", method: "PATCH" },
  delete_team:    { path: "/api/teams/{id}", method: "DELETE" },
  list_tasks:     { path: "/api/tasks/{teamId}" },
  create_task:    { path: "/api/tasks/{teamId}", method: "POST" },
  list_projects:  { path: "/api/projects" },
  get_settings:   { path: "/api/settings" },
  save_settings:  { path: "/api/settings", method: "PUT" },
  list_processes: { path: "/api/processes" },
  list_logs:      { path: "/api/stream/logs" },
  read_log_chunk: { path: "/api/stream?teamId={teamId}&since={since}" },
  spawn_claude:   { path: "/api/launch", method: "POST" },
  get_homedir:    { path: "/api/homedir" },
};

async function restFallback<T>(
  cmd: string,
  mapping: { path: string; method?: string },
  args?: Record<string, unknown>,
): Promise<T> {
  const method = mapping.method ?? "GET";
  const remaining: Record<string, unknown> = { ...(args ?? {}) };

  const url = mapping.path.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = remaining[key];
    delete remaining[key];
    return encodeURIComponent(String(value ?? ""));
  });

  const fetchOpts: RequestInit = { method };
  if (method !== "GET" && method !== "DELETE" && Object.keys(remaining).length > 0) {
    fetchOpts.headers = { "Content-Type": "application/json" };
    fetchOpts.body = JSON.stringify(remaining);
  }

  const response = await fetch(url, fetchOpts);
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`REST fallback for "${cmd}" failed (${response.status}): ${text}`);
  }

  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return undefined as T;
  return response.json() as Promise<T>;
}

export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    const mapping = REST_MAP[cmd];
    if (mapping) {
      return restFallback<T>(cmd, mapping, args);
    }
    throw new Error(
      `Tauri IPC unavailable: command "${cmd}" has no browser fallback. Run via \`bun run tauri:dev\`.`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { invoke } = await loadTauriCore() as any;
  return (invoke as (command: string, invokeArgs?: Record<string, unknown>) => Promise<T>)(cmd, args);
}

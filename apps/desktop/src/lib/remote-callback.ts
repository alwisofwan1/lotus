import { lotusApiCredentials, type LotusApiCredentials } from "@/lib/tauri-api";

/**
 * What an agent on another machine needs in its environment to report back.
 *
 * Three facts, all per-session: which pane it is, and where plus how to reach this desktop. They
 * ride as shell assignments in front of the remote `exec` rather than as a file on that machine —
 * a credential written to someone else's VPS outlives the session that needed it.
 *
 * The desktop's port and key do not change while it runs, so they are fetched once. A failure is
 * not fatal: the agent still runs, it simply cannot report, which is exactly what the topbar chip
 * is there to say.
 */
let cached: Promise<LotusApiCredentials> | null = null;

export function resetRemoteCallbackCache(): void {
  cached = null;
}

export async function remoteCallbackEnv(
  paneId: string | undefined,
): Promise<Record<string, string>> {
  if (!paneId) return {};
  try {
    cached ??= lotusApiCredentials();
    const credentials = await cached;
    return {
      LOTUS_PANE_ID: paneId,
      LOTUS_API_PORT: String(credentials.port),
      LOTUS_API_KEY: credentials.key,
    };
  } catch {
    // A desktop whose API has not bound yet cannot be called back. The pane id alone still lets a
    // hook that finds another route correlate itself.
    cached = null;
    return paneId ? { LOTUS_PANE_ID: paneId } : {};
  }
}

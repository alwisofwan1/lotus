/**
 * Generic SSH-vs-local location dispatcher factory.
 *
 * Encapsulates the routing logic shared by all workspace-aware `*For`
 * dispatchers: resolve an SSH context or local root from a workspace location,
 * call the appropriate function, and apply a no-root fallback.
 *
 * Usage:
 *   const myDispatcher = createLocationDispatcher({ toSshContext, toLocalRoot });
 *   return myDispatcher.route(location, sshOverride, localOverride, sshFn, localFn, onNoRoot);
 */

import type { CodeSpaceStoredWorkspaceLocation } from "./codespace";

// ── Public types ──────────────────────────────────────────────────────────────

/** Behaviour when neither SSH context nor local root can be resolved. */
export type OnNoRoot<T> =
  | { kind: "throw"; message: string }
  | { kind: "fallback"; value: T };

/** Configuration for a location dispatcher. */
export interface DispatcherConfig<TSsh> {
  /**
   * Extract an SSH context from `location`, optionally applying `sshOverride`
   * as the remote root. Returns `null` for non-SSH locations or when the
   * location is missing required fields.
   */
  toSshContext(
    location: CodeSpaceStoredWorkspaceLocation | null | undefined,
    sshOverride: string | undefined,
  ): TSsh | null;

  /**
   * Resolve the local filesystem root from `location`.
   * `localOverride` takes precedence when supplied.
   * Returns `""` when the root cannot be determined.
   */
  toLocalRoot(
    location: CodeSpaceStoredWorkspaceLocation | null | undefined,
    localOverride: string | undefined,
  ): string;
}

/** A dispatcher created by {@link createLocationDispatcher}. */
export interface LocationDispatcher<TSsh> {
  /** Extract SSH context — useful for operations that need the context directly. */
  getSshContext(
    location: CodeSpaceStoredWorkspaceLocation | null | undefined,
    sshOverride?: string,
  ): TSsh | null;

  /** Resolve local root — useful for operations that need the root directly. */
  getLocalRoot(
    location: CodeSpaceStoredWorkspaceLocation | null | undefined,
    localOverride?: string,
  ): string;

  /**
   * Route a single async operation.
   *
   * - SSH context resolves → `sshFn(ctx)` is called
   * - Local root resolves   → `localFn(root)` is called
   * - Neither resolves      → `onNoRoot` applies (throw or return fallback)
   */
  route<T>(
    location: CodeSpaceStoredWorkspaceLocation | null | undefined,
    sshOverride: string | undefined,
    localOverride: string | undefined,
    sshFn: (ctx: TSsh) => Promise<T>,
    localFn: (root: string) => Promise<T>,
    onNoRoot: OnNoRoot<T>,
  ): Promise<T>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createLocationDispatcher<TSsh>(
  config: DispatcherConfig<TSsh>,
): LocationDispatcher<TSsh> {
  return {
    getSshContext(location, sshOverride) {
      return config.toSshContext(location, sshOverride);
    },

    getLocalRoot(location, localOverride) {
      return config.toLocalRoot(location, localOverride);
    },

    async route(location, sshOverride, localOverride, sshFn, localFn, onNoRoot) {
      const ssh = config.toSshContext(location, sshOverride);
      if (ssh !== null) return sshFn(ssh);

      const root = config.toLocalRoot(location, localOverride);
      if (root) return localFn(root);

      if (onNoRoot.kind === "throw") throw new Error(onNoRoot.message);
      return onNoRoot.value;
    },
  };
}

"use client";

import { useEffect, useState } from "react";
import type { FoundCheckout } from "@/modules/automation/services/automation-api";

export type FindIssueCheckout = (
  repo: string,
  workspaces: { id: string; cwd: string }[],
  preferred: string | null,
  options: { namesake: boolean },
) => Promise<FoundCheckout | null>;

/**
 * Where a GitHub issue's code is on this machine: the workspace holding a checkout of its repo, and
 * the folder (the workspace root, or a repo directly inside it), so Delegate's default target is
 * the issue's own checkout instead of the board's folder or the rail's first workspace.
 *
 * `namesake` is on: a fork or transferred repo (`donisapu/e-coursetradding` checked out from
 * `mapantekno/e-coursetradding`) counts when it is the only folder by that name. Safe here because
 * the agent only reads and edits in that folder; Factory, which pushes, never asks for it.
 *
 * Remote workspaces are left out — git runs on this machine. `null` while reading, or when the repo
 * is checked out nowhere, and the caller keeps its other default.
 */
export function useIssueCheckout(
  repo: string | null,
  workspaces: () => { id: string; cwd: string; remote?: boolean }[],
  preferred: string | null,
  find: FindIssueCheckout,
): FoundCheckout | null {
  const [found, setFound] = useState<{ repo: string; at: FoundCheckout | null } | null>(null);
  useEffect(() => {
    if (!repo) return;
    let alive = true;
    const local = workspaces()
      .filter((workspace) => !workspace.remote && workspace.cwd)
      .map(({ id, cwd }) => ({ id, cwd }));
    // Through a promise, so a client that throws outright (outside Tauri) lands in the catch too.
    void Promise.resolve()
      .then(() => find(repo, local, preferred, { namesake: true }))
      .then((at) => {
        if (alive) setFound({ repo, at });
      })
      .catch(() => {
        if (alive) setFound({ repo, at: null });
      });
    return () => {
      alive = false;
    };
    // `workspaces` is read when the issue opens, like the panel's other workspace reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, preferred, find]);
  // An answer for the previous issue is not an answer for this one.
  return found && found.repo === repo ? found.at : null;
}

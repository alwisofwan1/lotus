import type { BridgeTask } from "@/modules/codespace/services/bridge/task-store";
import type { FindIssueCheckout } from "@/modules/tasks/hooks/useIssueCheckout";
import type { DelegateOptions } from "@/modules/tasks/hooks/useDelegation";
import { GITHUB_ISSUE_WRITE_DENY_RULES, namesakeCheckoutNote } from "@/modules/tasks/services/github-delegation";
import { NOTION_WRITE_DENY_RULES } from "@/modules/tasks/services/notion-delegation";

/**
 * What a task made from a Notion ticket or a GitHub issue is delegated with, wherever it is
 * delegated from — its Tasks row, or its node on the canvas (`plans/canvas-dock/` board 18).
 *
 * Its agents are kept from writing to where it came from. An issue's task runs in its workspace's
 * folder, so that folder is checked the way the issue panel checks it: an agent in a namesake clone
 * of the issue's repo (`owner/name#12` → another owner's `name`) is told where a push would go.
 */
export async function ticketDelegateOptions(
  task: Pick<BridgeTask, "workspaceId" | "source">,
  workspaces: () => { id: string; cwd: string; remote?: boolean }[],
  find: FindIssueCheckout,
): Promise<Pick<DelegateOptions, "denyTools" | "note"> | undefined> {
  if (task.source?.kind === "notion") return { denyTools: NOTION_WRITE_DENY_RULES };
  if (task.source?.kind !== "github") return undefined;
  const repo = task.source.ref.split("#")[0] ?? "";
  const folder = workspaces().find((workspace) => workspace.id === task.workspaceId && !workspace.remote && workspace.cwd);
  const found =
    repo && folder
      ? await Promise.resolve()
          .then(() => find(repo, [{ id: folder.id, cwd: folder.cwd }], folder.id, { namesake: true }))
          .catch(() => null)
      : null;
  return {
    denyTools: GITHUB_ISSUE_WRITE_DENY_RULES,
    ...(found?.namesake ? { note: namesakeCheckoutNote(repo, found.namesake) } : {}),
  };
}

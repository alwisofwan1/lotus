import type { Node } from "@xyflow/react";
import { factoryIssueTitle, type FactoryRef } from "@/modules/factory";
import { isFrameNode } from "./canvas-frames";

/**
 * Brainstorm live from the canvas (S3, ADR-0051): where the agent's terminal goes. Pure.
 *
 * The run's Frame holds the run's Factory node and the terminal that grills its ticket. The Frame
 * carries `data.taskKey` = `factory:<repo>#<issue>`, so a second brainstorm finds it again, also
 * after a reload. A Factory node already in some Frame keeps it: the terminal joins that one.
 */
export interface BrainstormRun {
  repo: string;
  issue: FactoryRef;
  title: string;
}

export type BrainstormFramePlan =
  | { kind: "join"; frameId: string; factoryNodeId: string | null; title: string }
  | { kind: "create"; factoryNodeId: string | null; title: string; taskKey: string };

export const CANVAS_BRAINSTORM_REMOTE =
  "This canvas runs on another machine. Brainstorm from Factory in Code for now.";

export const brainstormFrameKey = (run: Pick<BrainstormRun, "repo" | "issue">) =>
  `factory:${run.repo.toLowerCase()}#${run.issue}`;

const sameRun = (node: Node, run: Pick<BrainstormRun, "repo" | "issue">) => {
  const data = (node.data ?? {}) as { repo?: unknown; issue?: unknown };
  return (
    node.type === "factory" &&
    String(data.repo ?? "").toLowerCase() === run.repo.toLowerCase() &&
    String(data.issue ?? "") === String(run.issue)
  );
};

export function planBrainstormFrame(nodes: readonly Node[], run: BrainstormRun): BrainstormFramePlan {
  const taskKey = brainstormFrameKey(run);
  const title = factoryIssueTitle(run.issue, run.title);
  const factory = nodes.find((node) => sameRun(node, run)) ?? null;
  const factoryNodeId = factory?.id ?? null;
  const factoryFrame = (factory?.data as { frameId?: unknown } | undefined)?.frameId;
  if (typeof factoryFrame === "string" && nodes.some((n) => n.id === factoryFrame && isFrameNode(n))) {
    return { kind: "join", frameId: factoryFrame, factoryNodeId, title };
  }
  const keyed = nodes.find((n) => isFrameNode(n) && (n.data as { taskKey?: unknown } | undefined)?.taskKey === taskKey);
  if (keyed) return { kind: "join", frameId: keyed.id, factoryNodeId, title };
  return { kind: "create", factoryNodeId, title, taskKey };
}

const folderOf = (path: string) => path.trim().replace(/[\\/]+$/, "");
const holds = (root: string, path: string) => {
  const r = folderOf(root);
  const p = folderOf(path);
  return r !== "" && (p === r || p.startsWith(`${r}/`) || p.startsWith(`${r}\\`));
};

/**
 * The board the brainstorm terminal goes on. The terminal still runs in `checkout`; the board is the
 * canvas that holds it. A checkout inside the folder on screen stays there; else the canvas whose
 * folder holds it most closely; else a canvas for the checkout itself. Without this, a repo in a
 * subfolder (`acme-main/acme-web`) got a new canvas the user never made, where Delegate
 * keeps a subfolder's pane on its workspace's board.
 */
export function brainstormBoardFolder(checkout: string, boardFolder: string, projectFolders: readonly string[]): string {
  if (holds(boardFolder, checkout)) return boardFolder;
  const closest = projectFolders
    .filter((folder) => holds(folder, checkout))
    .sort((a, b) => folderOf(b).length - folderOf(a).length)[0];
  return closest ?? checkout;
}

/**
 * The agent, as the terminal's own process with the prompt as its first message. Never typed: the
 * prompt is several KB, and a PTY in a line editor's raw mode drops input past ~1 KB (rule 2).
 */
export const brainstormLaunchCommand = (prompt: string): string[] => ["claude", prompt];

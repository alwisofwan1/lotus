import type { Workspace } from "@/modules/codespace/components/types";
import type { FileLink } from "@/lib/file-link";
import { resolveFileLink } from "@/lib/file-link";
import { requestWorkbenchOpen } from "@/modules/codespace/services/workbench-open";

type RouteFileLinkInput = {
  workspace: Workspace;
  /**
   * The Editor pane used last. Not the focused pane: clicking the link has already moved focus
   * to the Thread the link is in.
   */
  preferredEditorId: string | null;
  /** The pane the link was clicked in; a new Editor pane opens beside it. */
  sourceCellId: string | null;
  link: FileLink;
  /** Opens an Editor pane beside `sourceCellId` and returns its id. */
  addEditorPane: (sourceCellId: string | null) => string;
};

export type RouteFileLinkResult = { ok: true; cellId: string } | { ok: false; reason: string };

/** The Editor pane used last, else the first one, else a new one — never more than one new pane. */
export function routeFileLink({
  workspace,
  preferredEditorId,
  sourceCellId,
  link,
  addEditorPane,
}: RouteFileLinkInput): RouteFileLinkResult {
  const resolved = resolveFileLink(link.path, workspace.cwd);
  if (!resolved.ok) return resolved;

  const editors = workspace.cells.filter((cell) => cell.type === "workbench");
  const cellId = editors.find((cell) => cell.id === preferredEditorId)?.id ?? editors[0]?.id ?? addEditorPane(sourceCellId);
  requestWorkbenchOpen(cellId, {
    path: resolved.path,
    ...(link.startLine !== undefined ? { startLine: link.startLine, endLine: link.endLine ?? link.startLine } : {}),
  });
  return { ok: true, cellId };
}

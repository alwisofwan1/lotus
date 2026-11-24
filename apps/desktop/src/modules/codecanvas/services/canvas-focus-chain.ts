import type { Edge } from "@xyflow/react";

export function uniqueCanvasFocusIds(ids: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function deriveSkillPreviewFocusChain(
  edges: readonly Edge[],
  skillsNodeId: string,
  skillNodeId: string,
): string[] {
  const terminalId = edges.find((edge) => edge.target === skillsNodeId)?.source;
  return uniqueCanvasFocusIds([terminalId, skillsNodeId, skillNodeId]);
}

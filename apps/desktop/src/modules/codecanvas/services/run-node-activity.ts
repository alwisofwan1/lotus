/**
 * Which Run Nodes are active right now — a session is live, or the record is paused (#74). The run
 * controller lives inside each Run Node, but the drop that changes members is decided by the canvas,
 * so each Run Node reports here. A run that never reported is not active.
 */
const active = new Set<string>();

export function setRunNodeActive(runNodeId: string, isActive: boolean): void {
  if (isActive) active.add(runNodeId);
  else active.delete(runNodeId);
}

export function isRunNodeActive(runNodeId: string): boolean {
  return active.has(runNodeId);
}

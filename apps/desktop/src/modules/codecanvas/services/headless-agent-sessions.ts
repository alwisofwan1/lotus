/** Running headless jobs survive board unmount; explicit node close owns their stop. */
const stops = new Map<string, () => Promise<void>>();

export function registerHeadlessAgentStop(paneId: string, stop: () => Promise<void>): () => void {
  stops.set(paneId, stop);
  return () => { if (stops.get(paneId) === stop) stops.delete(paneId); };
}

export async function stopHeadlessAgent(paneId: string): Promise<void> {
  const stop = stops.get(paneId);
  if (!stop) return;
  await stop();
  if (stops.get(paneId) === stop) stops.delete(paneId);
}

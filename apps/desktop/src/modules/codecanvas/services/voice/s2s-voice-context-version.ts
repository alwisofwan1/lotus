import type { S2sCanvasLiveVoiceContext } from "./s2s-canvas-live-context";

export interface S2sVoiceContextVersionState {
  key: string;
  version: number;
}

export function buildS2sVoiceContextKey(ctx: S2sCanvasLiveVoiceContext): string {
  return JSON.stringify({
    agents: ctx.agentTargetHints,
    nodes: ctx.nodeSummaries,
  });
}

export function nextS2sVoiceContextVersion(
  previous: S2sVoiceContextVersionState | null,
  ctx: S2sCanvasLiveVoiceContext,
): S2sVoiceContextVersionState {
  const key = buildS2sVoiceContextKey(ctx);
  if (previous && previous.key === key) return previous;
  return { key, version: previous ? previous.version + 1 : 1 };
}

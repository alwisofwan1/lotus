import type { SendResult } from "./canvas-agent-messaging";

export type CanvasCommandDeliverySource = "nl-command";

export type CanvasCommandDeliveryOutcome = "delivered" | "queued";

export interface CanvasCommandDeliveryEvent {
  id: string;
  source: CanvasCommandDeliverySource;
  /** Canvas node receiving the payload (Agent or plain Terminal). */
  targetNodeId: string;
  outcome: CanvasCommandDeliveryOutcome;
  commandPreview: string;
  createdAt: number;
}

interface CreateCanvasCommandDeliveryEventsOptions {
  source: CanvasCommandDeliverySource;
  targetNodeId: string;
  text: string;
  result: SendResult;
  now?: () => number;
  idFactory?: () => string;
}

const DEFAULT_PREVIEW_LIMIT = 96;

interface CreateCanvasCommandDeliveryEventOptions {
  source: CanvasCommandDeliverySource;
  targetNodeId: string;
  text: string;
  outcome: CanvasCommandDeliveryOutcome;
  now?: () => number;
  idFactory?: () => string;
}

function compactPreview(text: string, limit = DEFAULT_PREVIEW_LIMIT): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function createCanvasCommandDeliveryEvent({
  source,
  targetNodeId,
  text,
  outcome,
  now = () => Date.now(),
  idFactory = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
}: CreateCanvasCommandDeliveryEventOptions): CanvasCommandDeliveryEvent {
  return {
    id: idFactory(),
    source,
    targetNodeId,
    outcome,
    commandPreview: compactPreview(text),
    createdAt: now(),
  };
}

export function createCanvasCommandDeliveryEvents({
  source,
  targetNodeId,
  text,
  result,
  now = () => Date.now(),
  idFactory = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`),
}: CreateCanvasCommandDeliveryEventsOptions): CanvasCommandDeliveryEvent[] {
  const emitted: CanvasCommandDeliveryEvent[] = [];
  const append = (ids: string[], outcome: CanvasCommandDeliveryOutcome) => {
    ids.forEach((id) => {
      emitted.push({
        id: idFactory(),
        source,
        targetNodeId: id,
        outcome,
        commandPreview: compactPreview(text),
        createdAt: now(),
      });
    });
  };
  append(result.delivered, "delivered");
  append(result.queued, "queued");
  return emitted.filter((event) => event.targetNodeId === targetNodeId || targetNodeId === "__all__");
}

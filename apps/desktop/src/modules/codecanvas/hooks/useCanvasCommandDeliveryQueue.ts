"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasCommandDeliveryEvent } from "../services/canvas-command-delivery";

/** Hard timeout only; normal removal happens when the overlay reports animation completion. */
export const CANVAS_COMMAND_DELIVERY_DURATION_MS = 5_000;

interface UseCanvasCommandDeliveryQueueOptions {
  durationMs?: number;
}

export function useCanvasCommandDeliveryQueue({
  durationMs = CANVAS_COMMAND_DELIVERY_DURATION_MS,
}: UseCanvasCommandDeliveryQueueOptions = {}) {
  const [deliveries, setDeliveries] = useState<CanvasCommandDeliveryEvent[]>([]);
  const timers = useRef<Map<string, number>>(new Map());

  const complete = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
    setDeliveries((current) => current.filter((delivery) => delivery.id !== id));
  }, []);

  const enqueue = useCallback(
    (event: CanvasCommandDeliveryEvent) => {
      const previousTimer = timers.current.get(event.id);
      if (previousTimer !== undefined) window.clearTimeout(previousTimer);
      setDeliveries((current) => [...current.filter((delivery) => delivery.id !== event.id), event]);
      const timer = window.setTimeout(() => complete(event.id), durationMs);
      timers.current.set(event.id, timer);
    },
    [complete, durationMs],
  );

  useEffect(
    () => () => {
      timers.current.forEach((timer) => window.clearTimeout(timer));
      timers.current.clear();
    },
    [],
  );

  return { deliveries, enqueue, complete };
}

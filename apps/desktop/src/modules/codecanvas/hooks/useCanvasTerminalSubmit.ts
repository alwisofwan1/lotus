"use client";

import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { Node } from "@xyflow/react";
import {
  createCanvasCommandDeliveryEvent,
  type CanvasCommandDeliveryEvent,
} from "../services/canvas-command-delivery";
import { deliverCanvasTerminalText } from "../services/terminal/canvas-terminal-delivery";

type Trace = { text: string; tone: "ok" | "error" };

export interface UseCanvasTerminalSubmitOptions {
  nodes: Node[];
  onCommandDelivery?: (event: CanvasCommandDeliveryEvent) => void;
  setText: Dispatch<SetStateAction<string>>;
  setTrace: Dispatch<SetStateAction<Trace | null>>;
}

export interface CanvasTerminalSubmitOptions {
  signal?: AbortSignal;
}

/** Compose receipt-bearing Canvas Terminal delivery with honest NL-bar feedback. */
export function useCanvasTerminalSubmit({
  nodes,
  onCommandDelivery,
  setText,
  setTrace,
}: UseCanvasTerminalSubmitOptions) {
  return useCallback(async (
    nodeId: string,
    nodeName: string,
    input: string,
    options: CanvasTerminalSubmitOptions = {},
  ): Promise<boolean> => {
    if (options.signal?.aborted) return false;
    const result = await deliverCanvasTerminalText(nodeId, input, nodes, { signal: options.signal });
    if (options.signal?.aborted) return false;
    if (!result.ok) {
      // A late failed receipt must not overwrite text the user typed while the write was pending.
      setText((current) => current || input);
      setTrace({ text: result.message, tone: "error" });
      return false;
    }

    const preview = result.text.length > 80 ? `${result.text.slice(0, 79)}…` : result.text;
    setTrace({ text: `Sent to ${result.nodeName || nodeName}: “${preview}”`, tone: "ok" });
    onCommandDelivery?.(createCanvasCommandDeliveryEvent({
      source: "nl-command",
      targetNodeId: result.nodeId,
      text: result.text,
      outcome: "delivered",
    }));
    return true;
  }, [nodes, onCommandDelivery, setText, setTrace]);
}

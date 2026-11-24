import type { Node } from "@xyflow/react";
import {
  getTerminalSessionStatus,
  writeTerminalSessionConfirmed,
  type TerminalRuntimeStatus,
} from "@/modules/codespace/services/terminal-session-registry";
import type { TerminalInputMetadata } from "@/modules/codespace/services/terminal-input-events";
import { encodeTerminalTextSubmission } from "@/modules/codespace/services/terminal-submit";
import { waitForClassicVoiceStage } from "../voice/classic-voice-stage-deadline";
import { buildNodeIndex, resolveNodeByName } from "../canvas-nl-command";
import { terminalDisplayName } from "./terminal-node-identity";

const DEFAULT_TERMINAL_DELIVERY_TIMEOUT_MS = 5_000;

export type CanvasTerminalDeliveryResult =
  | { ok: true; nodeId: string; nodeName: string; paneId: string; text: string }
  | { ok: false; nodeId: string; nodeName: string; reason: "unavailable" | "write-failed" | "delivery-unknown"; message: string };

export interface AddressedCanvasTerminalText {
  nodeId: string;
  nodeName: string;
  text: string;
}

/** Resolve explicit `tell Terminal … to …` and `Terminal …, …` typed addressing without a model. */
export function resolveAddressedCanvasTerminalText(
  rawText: string,
  nodes: Node[],
): AddressedCanvasTerminalText | null {
  const text = rawText.trim();
  const match = text.match(/^(?:tell|ask)\s+(.+?)\s+to\s+([\s\S]+)$/i)
    ?? text.match(/^([^,:]+?)\s*[,:]\s*([\s\S]+)$/);
  if (!match) return null;

  const terminalRefs = buildNodeIndex(nodes).filter((ref) => ref.kind === "terminal");
  const resolved = resolveNodeByName(match[1].trim(), terminalRefs, { kind: "terminal" });
  if (!resolved.ok) return null;
  const payload = match[2].trim();
  if (!payload) return null;
  return { nodeId: resolved.id, nodeName: resolved.ref.name, text: payload };
}

export interface CanvasTerminalDeliveryDeps {
  getStatus?: (paneId: string) => TerminalRuntimeStatus;
  writeConfirmed?: (
    paneId: string,
    data: string,
    metadata?: Partial<TerminalInputMetadata>,
  ) => Promise<void>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Submit literal NL-bar text to one concrete Canvas Terminal and await native PTY acceptance. */
export async function deliverCanvasTerminalText(
  nodeId: string,
  rawText: string,
  nodes: readonly Node[],
  deps: CanvasTerminalDeliveryDeps = {},
): Promise<CanvasTerminalDeliveryResult> {
  const node = nodes.find((candidate) => candidate.id === nodeId && candidate.type === "terminal");
  const nodeName = node
    ? terminalDisplayName({ label: node.data?.label, terminalNumber: node.data?.terminalNumber })
    : "Terminal";
  if (!node) {
    return { ok: false, nodeId, nodeName, reason: "unavailable", message: "Terminal target is no longer on the canvas." };
  }

  const runtimePaneId = typeof node.data?.runtimePaneId === "string" && node.data.runtimePaneId
    ? node.data.runtimePaneId
    : node.id;
  const getStatus = deps.getStatus ?? getTerminalSessionStatus;
  const status = getStatus(runtimePaneId);
  if (status !== "live" && status !== "detached") {
    return {
      ok: false,
      nodeId,
      nodeName,
      reason: "unavailable",
      message: `${nodeName} isn't writable — start or recover it first.`,
    };
  }

  const text = rawText.trim();
  if (!text) {
    return { ok: false, nodeId, nodeName, reason: "unavailable", message: "Enter a command to send." };
  }
  const metadata: Partial<TerminalInputMetadata> = {
    origin: "programmatic",
    intent: "shell-command",
    submitted: true,
    promptText: text,
  };

  try {
    await waitForClassicVoiceStage(
      (deps.writeConfirmed ?? writeTerminalSessionConfirmed)(
        runtimePaneId,
        encodeTerminalTextSubmission(text),
        metadata,
      ),
      {
        stage: "Terminal delivery confirmation",
        timeoutMs: deps.timeoutMs ?? DEFAULT_TERMINAL_DELIVERY_TIMEOUT_MS,
        signal: deps.signal,
      },
    );
    return { ok: true, nodeId, nodeName, paneId: runtimePaneId, text };
  } catch (error) {
    const timedOut = error instanceof Error && error.message.includes("timed out");
    return {
      ok: false,
      nodeId,
      nodeName,
      reason: timedOut ? "delivery-unknown" : "write-failed",
      message: timedOut
        ? `Delivery status is unknown for ${nodeName} — check the terminal before retrying.`
        : `Couldn't confirm delivery to ${nodeName}. Check the terminal and try again.`,
    };
  }
}

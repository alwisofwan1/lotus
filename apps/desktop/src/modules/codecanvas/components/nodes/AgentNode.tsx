"use client";
import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { HeadlessAgentNode } from "./HeadlessAgentNode";
import { LiveAgentNode } from "./LiveAgentNode";
import type { CanvasAgentNodeData } from "../../types/canvas";

/**
 * Canvas Agent Node entry point. Dispatches on Agent Execution Mode (ADR-0022): a `live` node is a
 * persistent interactive PTY persona; anything else stays the headless one-shot graph worker.
 * `live` is the default for newly created nodes; snapshots predating the field load as headless.
 */
export const AgentNode = memo(function AgentNode(props: NodeProps) {
  const { executionMode } = props.data as CanvasAgentNodeData;
  return executionMode === "live" ? <LiveAgentNode {...props} /> : <HeadlessAgentNode {...props} />;
});

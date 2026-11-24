import type { Node } from "@xyflow/react";
import type { AgentStatusSnapshot } from "./agent-status-registry";
import { normalizeTerminalLabel, terminalDefaultName, terminalDisplayName } from "./terminal/terminal-node-identity";

export const CANVAS_NAVIGATOR_TYPES = [
  "agent",
  "team",
  "critic",
  "human-gate",
  "task",
  "context",
  "plan",
  "terminal",
  "note",
  "skills",
  "skill",
  "browser",
] as const;

export type CanvasNavigatorType = typeof CANVAS_NAVIGATOR_TYPES[number];

export interface CanvasNodeDescriptor {
  id: string;
  type: CanvasNavigatorType | "node";
  label: string;
  detail: string;
  status?: string;
}

export function isCanvasNavigatorType(type: string | undefined): type is CanvasNavigatorType {
  return !!type && (CANVAS_NAVIGATOR_TYPES as readonly string[]).includes(type);
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function firstLine(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim().split(/\r?\n/)[0] || fallback : fallback;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/** Shared display metadata for CodeCanvas sidebars and run inspectors. */
export function describeCanvasNode(
  node: Node,
  index: number,
  liveStatus?: AgentStatusSnapshot,
): CanvasNodeDescriptor {
  const data = node.data as Record<string, unknown> | undefined;
  const type = isCanvasNavigatorType(node.type) ? node.type : "node";

  if (type === "terminal") {
    const cwd = typeof data?.cwd === "string" ? data.cwd : "";
    const terminalNumber = data?.terminalNumber;
    const customLabel = normalizeTerminalLabel(data?.label);
    const location = basename(cwd);
    return {
      id: node.id,
      type,
      label: terminalDisplayName({ label: customLabel, terminalNumber }),
      detail: [customLabel ? terminalDefaultName(terminalNumber) : "", location].filter(Boolean).join(" · "),
    };
  }

  if (type === "note") {
    return { id: node.id, type, label: `Note ${index + 1}`, detail: firstLine(data?.content, "note") };
  }

  if (type === "agent") {
    const label = typeof data?.name === "string" ? data.name : `Agent ${index + 1}`;
    const model = typeof data?.model === "string" ? data.model : "agent";
    return { id: node.id, type, label, detail: model, status: liveStatus?.status };
  }

  if (type === "team") {
    const label = typeof data?.name === "string" ? data.name : `Team ${index + 1}`;
    const members = Array.isArray(data?.members) ? countLabel(data.members.length, "member") : "team";
    return { id: node.id, type, label, detail: members, status: liveStatus?.status };
  }

  if (type === "critic") {
    const label = typeof data?.title === "string" ? data.title : `Critic ${index + 1}`;
    const model = typeof data?.model === "string" ? data.model : "critic gate";
    return { id: node.id, type, label, detail: model, status: liveStatus?.status };
  }

  if (type === "human-gate") {
    const label = typeof data?.title === "string" ? data.title : `Human Gate ${index + 1}`;
    const status = typeof data?.status === "string" ? data.status : "idle";
    const gateKind = typeof data?.gateKind === "string" ? data.gateKind : "approval";
    return { id: node.id, type, label, detail: `human ${gateKind}`, status };
  }

  if (type === "task") {
    const label = typeof data?.title === "string" ? data.title : `Task ${index + 1}`;
    const status = typeof data?.status === "string" ? data.status : "todo";
    const priority = typeof data?.priority === "string" && data.priority !== "none" ? ` · ${data.priority}` : "";
    return { id: node.id, type, label, detail: `task · ${status}${priority}`, status };
  }

  if (type === "context") {
    const label = typeof data?.title === "string" ? data.title : `Context ${index + 1}`;
    return { id: node.id, type, label, detail: "context bus" };
  }

  if (type === "plan") {
    const label = typeof data?.title === "string" ? data.title : `Plan ${index + 1}`;
    const steps = Array.isArray(data?.steps) ? countLabel(data.steps.length, "step") : "plan";
    return { id: node.id, type, label, detail: steps };
  }

  if (type === "skills") {
    return { id: node.id, type, label: `Skills ${index + 1}`, detail: "skill browser" };
  }

  if (type === "skill") {
    const label = typeof data?.name === "string" ? `/${data.name}` : `Skill ${index + 1}`;
    return { id: node.id, type, label, detail: "skill" };
  }

  if (type === "browser") {
    const url = typeof data?.url === "string" ? data.url : "about:blank";
    const state = typeof data?.state === "string" ? data.state : "disconnected";
    return { id: node.id, type, label: `Browser ${index + 1}`, detail: url, status: state };
  }

  return { id: node.id, type, label: `Node ${index + 1}`, detail: node.type ?? "node" };
}

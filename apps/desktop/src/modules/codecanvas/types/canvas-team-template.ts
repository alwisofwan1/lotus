import type { AgentDefinition, CanvasEdgeRecord, CanvasNodeRecord, CanvasNodeSize } from "./canvas";

export interface CanvasTemplateTerminalNode {
  kind: "terminal";
  id: string;
  size: CanvasNodeSize;
}

export interface CanvasTemplateAgentNode {
  kind: "agent";
  id: string;
  size: CanvasNodeSize;
  definition: AgentDefinition;
}

export interface CanvasTemplateNoteNode {
  kind: "note";
  id: string;
  size: CanvasNodeSize;
  content: string;
}

export type CanvasTemplateNode =
  | CanvasTemplateTerminalNode
  | CanvasTemplateAgentNode
  | CanvasTemplateNoteNode;

export interface CanvasTemplateEdge {
  source: string;
  target: string;
  kind?: string;
}

export interface CanvasTeamTemplate {
  id: string;
  name: string;
  createdAt: number;
  nodes: CanvasTemplateNode[];
  edges: CanvasTemplateEdge[];
}

export type CanvasBlueprintCategory = "builtin" | "user" | "imported";
export type TemplateVariableType = "text" | "textarea" | "select";
export type TemplateContextSourceKind = "file" | "directory" | "url" | "note";
export type TemplateLayoutDirection = "LR" | "TB";
export type TemplateAgentEffort = "minimal" | "low" | "medium" | "high" | "max";
export type TemplateAgentPermissionMode = "full" | "safe";

export interface TemplateVariable {
  key: string;
  label: string;
  type: TemplateVariableType;
  required: boolean;
  defaultValue?: string;
  options?: string[];
  help?: string;
}

export interface TemplateAgentDefinition {
  key: string;
  name: string;
  role?: string;
  model: string;
  promptTemplate: string;
  appliedSkills: string[];
  effort: TemplateAgentEffort;
  permissionMode: TemplateAgentPermissionMode;
}

export interface TemplateContextSource {
  label: string;
  kind: TemplateContextSourceKind;
  value: string;
  required?: boolean;
}

export interface TemplatePromptDefaults {
  mission?: string;
  customPrompt?: string;
  definitionOfDone?: string;
}

export interface CanvasTemplateLayout {
  engine: "dagre" | "manual";
  direction: TemplateLayoutDirection;
}

export interface CanvasTeamTemplateV2 {
  schemaVersion: 2;
  id: string;
  name: string;
  description: string;
  category: CanvasBlueprintCategory;
  tags: string[];
  icon?: string;
  createdAt: number;
  updatedAt: number;
  variables: TemplateVariable[];
  roster: TemplateAgentDefinition[];
  guardrails: string[];
  contextSources: TemplateContextSource[];
  nodes: CanvasTemplateNode[];
  edges: CanvasTemplateEdge[];
  promptDefaults?: TemplatePromptDefaults;
  layout?: CanvasTemplateLayout;
}

export type CanvasWorkflowTemplateStatus = "draft" | "active" | "archived";

export type CanvasWorkflowTemplateTrigger =
  | { kind: "manual" }
  | { kind: "schedule"; cron: string };

export interface CanvasWorkflowTemplateV3 extends Omit<CanvasTeamTemplateV2, "schemaVersion" | "nodes" | "edges"> {
  schemaVersion: 3;
  status: CanvasWorkflowTemplateStatus;
  trigger: CanvasWorkflowTemplateTrigger;
  sourceTemplateId?: string;
  nodes: (CanvasTemplateNode | CanvasNodeRecord)[];
  edges: (CanvasTemplateEdge | CanvasEdgeRecord)[];
}

export type CanvasStoredTemplate = CanvasTeamTemplate | CanvasTeamTemplateV2 | CanvasWorkflowTemplateV3;

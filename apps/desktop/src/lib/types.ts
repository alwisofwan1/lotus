import type { ReasoningLevel } from "@/lib/agent-runtime/reasoning-effort";

export type AgentStatus = "idle" | "working" | "waiting" | "done" | "error";
export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked";
export type TeamRole = "lead" | "frontend" | "backend" | "security" | "tester" | "reviewer" | "architect" | "devops" | "custom";
export type DisplayMode = "in-process" | "split-panes";

export interface Agent {
  id: string;
  name: string;
  role: TeamRole;
  model: string;
  status: AgentStatus;
  currentTask?: string;
  avatar: string;
  color: string;
  agentType?: string;
  tokensUsed: number;
  messagesCount: number;
  joinedAt: Date;
  isLead: boolean;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignedTo?: string;
  dependencies: string[];
  priority: "low" | "medium" | "high" | "critical";
  createdAt: Date;
  updatedAt: Date;
  tags: string[];
  files?: string[];
  estimatedTokens?: number;
}

export interface Message {
  id: string;
  from: string;
  to: string | "broadcast";
  content: string;
  timestamp: Date;
  type: "message" | "task_update" | "plan_request" | "plan_approved" | "shutdown" | "status";
  read: boolean;
}

export interface Team {
  id: string;
  name: string;
  description: string;
  lead: string;
  agents: Agent[];
  tasks: Task[];
  messages: Message[];
  createdAt: Date;
  status: "active" | "idle" | "completed";
  displayMode: DisplayMode;
  totalTokens: number;
  project: string;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  roles: { role: TeamRole; name: string; prompt: string }[];
  taskTemplate: string[];
  useCase: string;
}

// ─── CodeChat: Template Config ────────────────────────────

export type TemplateMode = "agent" | "stream";

export interface ChatTemplate {
  id: string;
  name: string;
  icon: string;
  description: string;
  mode: TemplateMode;
  systemPrompt: string;
  color: string;
  toolIds?: string[];
  maxSteps?: number;
  requiresTools?: boolean;
}

// ─── CodeChat: Agent Runtime Config ───────────────────────

export type CodeChatParserType = "claude-stream-json" | "codex-json" | "cursor-stream-json" | "raw";
/**
 * CodeChat's effort names, which are the app's effort names.
 *
 * This union used to be written out here as `minimal | low | medium | high | max`, while the
 * Bridge planner had its own — so `max` meant a different amount of thinking depending on the
 * surface. Both are now the one vocabulary in `lib/agent-runtime/reasoning-effort.ts`, which was
 * measured against the CLI: `minimal` is not a level Claude accepts, and a stored one is carried
 * to `low` by `normalizeReasoningLevel` rather than being offered again.
 */
export type CodeChatEffort = ReasoningLevel;
export type CodeChatRuntimeMode = "headless" | "pty";

export interface CodeChatModelOption {
  label: string;
  value: string;
}

export interface CodeChatAgentConfig {
  id: string;
  name: string;
  providerId?: string;
  description: string;
  command: string[];
  parser: CodeChatParserType;
  runtimeMode: CodeChatRuntimeMode;
  models: CodeChatModelOption[];
  defaultModel: string;
  effortOptions: CodeChatEffort[];
  defaultEffort: CodeChatEffort;
  supportsImageAttachments?: boolean;
}

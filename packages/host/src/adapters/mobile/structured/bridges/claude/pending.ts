import type {
  Part,
  PermissionOption,
  PermissionPart,
  QuestionPart,
  RunnerTranscriptCaps,
  Turn,
} from "../../../../../types/conversation.js";
import { denialsOf, toolKindOf, toolTargetOf, usageOf } from "./messages.js";
import { answerUserQuestion, readUserQuestion } from "../../../questions.js";
import type { ClaudeMessage } from "./messages.js";
import type { ApprovalAnswer } from "./approval-host.js";

/** The gated tool that is a question rather than a request to act. See `questions.ts`. */
export const CLAUDE_USER_QUESTION_TOOL = "AskUserQuestion";

/**
 * Keys are **printed digits**, as in every bridge, so `/input` needs no runner knowledge (ADR-8:
 * never the option's position). "Always" is enforced by the runner via `updatedPermissions`.
 */
export function claudePermissionOptions(toolName: string): PermissionOption[] {
  const deny: PermissionOption = { key: "1", label: "Deny", kind: "reject_once" };
  // A question never gets a standing grant. Letting `AskUserQuestion` through unasked does not
  // make it answer itself — it runs, finds no interface, and returns *"No answer received"*. So
  // the grant would silence every later question while telling the agent nobody replied, with
  // no card ever reaching the operator. The one grant that must not exist.
  if (toolName === CLAUDE_USER_QUESTION_TOOL) {
    return [{ key: "1", label: "Allow once", kind: "allow_once" }, { ...deny, key: "2" }];
  }
  return [
    { key: "1", label: "Allow once", kind: "allow_once" },
    { key: "2", label: sessionGrantLabel(toolName), kind: "allow_always" },
    { ...deny, key: "3" },
  ];
}

/**
 * The middle button must promise exactly what it gives. The only rule Lotus can compose is
 * `{toolName}`, so granting one `Bash` command grants **every** `Bash` in the cell: the label
 * names the tool and lifetime, never the command.
 */
export function sessionGrantLabel(toolName: string): string {
  return `Allow all ${toolName} until this cell closes`;
}

export function claudePermissionPart(args: {
  requestId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  stamp: { id: string; ts: number; seq: number; provenance: "native" };
}): PermissionPart | QuestionPart {
  // **A question is not a permission**, and this is where the two part ways. A permission asks
  // leave to act and takes a yes or a no; this asks the operator to *choose*, and every option
  // carries a sentence of its own — words a `{key,label}` has nowhere to keep, so a headless
  // cell showed the labels and dropped what they meant.
  const asked = args.toolName === CLAUDE_USER_QUESTION_TOOL ? readUserQuestion(args.input) : undefined;
  if (asked !== undefined) {
    return {
      type: "question",
      requestId: args.requestId,
      ...(args.toolUseId === "" ? {} : { toolCallId: args.toolUseId }),
      questions: [
        {
          ...asked,
          // The printed digits, as everything on this wire is answered (ADR-8). They exist here
          // because the bridge is holding the call open; a TUI cell's question carries none.
          options: asked.options.map((option, i) => ({ ...option, key: String(i + 1) })),
        },
      ],
      ...args.stamp,
    };
  }
  const target = toolTargetOf(args.toolName, args.input);
  return {
    type: "permission",
    requestId: args.requestId,
    ...(args.toolUseId === "" ? {} : { toolCallId: args.toolUseId }),
    title: target === "" ? args.toolName : `${args.toolName} ${target}`,
    options: claudePermissionOptions(args.toolName),
    ...args.stamp,
  };
}

/** The newest question still without an answer, searched newest-first. */
export function findPendingQuestion(turns: readonly Turn[]): QuestionPart | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const parts = turns[i]?.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (part?.type === "question" && part.answered === undefined) return part;
    }
  }
  return undefined;
}

/** The newest permission still without an outcome, searched newest-first. */
export function findPending(turns: readonly Turn[]): PermissionPart | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    const parts = turns[i]?.parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (part?.type === "permission" && part.outcome === undefined) return part;
    }
  }
  return undefined;
}

/**
 * What this wire gives, per dimension. Every `expected` was seen in a real capture;
 * `permission` is `expected` because the runner asks and waits (`approval-host.ts`).
 */
export const CLAUDE_STREAM_CAPS: Partial<RunnerTranscriptCaps> = {
  turns: "expected",
  text: "expected",
  streaming: "expected",
  reasoning: "expected",
  toolCalls: "expected",
  toolStatus: "expected",
  output: "expected",
  diff: "expected",
  usage: "expected",
  permission: "expected",
  plan: "expected",
};

/**
 * The parts a turn's `result` produces: each refused tool, then the closing account.
 * A refused tool has no `tool_use` block, so this is the only place it shows. Absent counts
 * stay absent (no tokens must not render as zero).
 */
export function closingParts(
  message: ClaudeMessage,
  durationMs: number,
  stamp: (suffix: string) => { id: string; ts: number; seq: number; provenance: "native" },
): Part[] {
  const parts: Part[] = [];
  for (const denial of denialsOf(message)) {
    parts.push({
      ...stamp(`denied-${denial.toolUseId}`),
      type: "tool_call",
      toolCallId: denial.toolUseId === "" ? `denied-${denial.toolName}` : denial.toolUseId,
      toolName: denial.toolName,
      title: denial.target,
      kind: toolKindOf(denial.toolName),
      status: "failed",
      locations: [],
      output: { text: "Permission for this tool use was denied.", truncated: false },
    });
  }
  const usage = usageOf(message["usage"]);
  const cost = message["total_cost_usd"];
  parts.push({
    ...stamp("result"),
    type: "result",
    isError: message["is_error"] === true,
    durationMs,
    ...(usage === undefined ? {} : { usage }),
    ...(typeof cost === "number" ? { costUsd: cost } : {}),
  });
  return parts;
}

/**
 * The operator's choice as the runner receives it. A **question** answer must reach the tool by
 * returning its input with the answer written in; otherwise `AskUserQuestion` returns "No answer
 * received". Pure and exported for testing.
 */
export function approvalAnswerFor(
  request: { toolName: string; input: Record<string, unknown> },
  option: PermissionOption,
): ApprovalAnswer {
  if (option.kind !== "allow_once" && option.kind !== "allow_always") {
    return { behavior: "deny", message: "The operator declined." };
  }
  if (request.toolName === CLAUDE_USER_QUESTION_TOOL) {
    return { behavior: "allow", updatedInput: answerUserQuestion(request.input, option.label) };
  }
  return option.kind === "allow_always"
    ? {
        behavior: "allow",
        updatedPermissions: [
          {
            type: "addRules",
            // The tool's own name and nothing narrower. Without `suggestions` from the CLI
            // there is no rule syntax to compose a tighter one from, and guessing at one is
            // how a grant comes to admit what nobody agreed to. The **label** is what keeps
            // this honest (`sessionGrantLabel`).
            rules: [{ toolName: request.toolName }],
            behavior: "allow",
            destination: "session",
          },
        ],
      }
    : { behavior: "allow" };
}

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
 * The answers a Claude cell's permission takes.
 *
 * The keys are **printed digits**, the same as every other bridge here, so the phone answers
 * an approval through `/input` with a keystroke and no route has to know which runner it is
 * talking to (ADR-8: never the option's position — the digit itself).
 *
 * **There were two of these until 2026-09-08, and the reason written here was wrong.** It said
 * an *always* would have to be enforced by this host rather than by the runner — a policy
 * engine, not a bridge. Probed against the real CLI: `--permission-prompt-tool` accepts
 * `updatedPermissions`, and the runner honours it. Two Bash calls behind one grant were asked
 * about **once**; the control without it was asked twice, and both commands ran in both.
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
 * What the middle button promises, and it has to promise exactly what it gives.
 *
 * The channel carries no `suggestions`, so the only rule Lotus can compose is `{toolName}` —
 * granting `rm -f doomed.txt` grants **every** `Bash` in this cell. A button reading "Allow for
 * session" over that is wider than its words, and the words are all the operator reads. So it
 * names the tool and the lifetime and nothing narrower: never the command, which the rule
 * cannot be limited to.
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
 * What this wire actually gives, per dimension — data, so it reads as a table rather than as
 * an object literal buried in a method.
 *
 * Every `expected` here was seen in a real capture. `permission` is `expected` because the
 * runner asks and waits (`approval-host.ts`); it was `never` until that existed, and the
 * difference is the whole of Fase 3b.
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
};

/**
 * The parts a turn's `result` produces: every tool the runner was refused, then the closing
 * account.
 *
 * A refused tool never produced a `tool_use` block, so this is the only place the operator
 * can learn it was wanted at all. Absent counts stay absent — a turn that reported no tokens
 * must not render as zero.
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
 * The operator's choice, as the runner needs to receive it.
 *
 * Two different acts share this one channel. Granting a **permission** is a yes, and the tool
 * runs with the arguments it already had. Answering a **question** is not a yes at all: the
 * chosen label has to reach the tool, and the only way through `--permission-prompt-tool` is
 * to hand back the tool's own input with the answer written into it. Probed against the real
 * CLI on 2026-09-08 — without it `AskUserQuestion` runs and returns *"No answer received"*,
 * so the operator taps an option and the agent is told nobody replied.
 *
 * Pure and exported so the mapping can be read and tested without a socket or a process.
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

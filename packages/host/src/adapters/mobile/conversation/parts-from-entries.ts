import type {
  Part,
  Provenance,
  QuestionPart,
  ToolCallPart,
  Turn,
} from "../../../types/conversation.js";
import type { TranscriptEntry } from "../../../types/transcript.js";
import { kindNamesAFile, stableId, toolKindOf } from "./tool-kind.js";

/**
 * Hook-vocabulary entries → turns of parts. Pure, so it is tested against the committed
 * transcript fixtures and nothing else.
 *
 * This is the phone's `ChatTranscript.of` rewritten to *produce structure* instead of
 * lines, with the same three rules it learned the hard way — and they are kept here, on
 * the host, so every client gets the same turns:
 *
 * 1. A **turn** opens on `prompt-submit`, or — for a host that never sent one — when
 *    `userPrompt` changes or a `stop` has gone by since the last bubble. Repeating the same
 *    sentence after a turn ended is a new turn, not a continuation (2026-08-08).
 * 2. **`body` means different things per `event`**: a reply on `stop`, a path on a tool
 *    event, the operator's words on `prompt-submit`. That switch lives here and nowhere
 *    downstream.
 * 3. A **tool call and its result are one part**. `tool-pre` opens a `tool_call` as
 *    `in_progress`; the next `tool-post` with the same tool name completes it (or fails it,
 *    on `tool-post-failed`) and carries the diffstat. A `tool-post` with nothing open — the
 *    ring having evicted its `tool-pre` — still becomes a completed call, so a step is never
 *    lost to a cap.
 *
 * Entries arrive oldest first and stay that way.
 */
export function turnsFromEntries(entries: readonly TranscriptEntry[], provenance: Provenance): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | undefined;
  let lastPrompt: string | undefined;
  let turnEnded = false;
  /**
   * Whether the open turn was opened by a real `prompt-submit`. While it is, a differing
   * `userPrompt` on a later entry is **not** a new turn: the two fields are clipped at
   * different caps (8000 bytes vs the shorter `userPrompt` cap), so a long prompt would
   * otherwise open a phantom turn on its very next step — found by the phone's
   * `AgentOutcome` test on 2026-08-27, where a 6-minute turn came back as 5:59.
   */
  let openedBySubmit = false;
  let seq = 0;

  const base = (e: TranscriptEntry) => ({
    id: stableId(`${e.timestamp}|${e.event}|${e.title}|${e.toolTarget}|${e.body.length}`),
    ts: e.timestamp,
    seq: seq++,
    provenance,
  });

  const open = (at: number, id: string): Turn => {
    const turn: Turn = { turnId: `t-${id}`, startedAt: at, parts: [] };
    turns.push(turn);
    turnEnded = false;
    return turn;
  };
  const here = (e: TranscriptEntry): Turn => current ?? (current = open(e.timestamp, base(e).id));
  const push = (turn: Turn, part: Part) => turn.parts.push(part);

  for (const e of entries) {
    const event = e.event.trim().toLowerCase();

    if (event === "prompt-submit") {
      const b = base(e);
      current = open(e.timestamp, b.id);
      lastPrompt = e.body;
      openedBySubmit = true;
      if (e.body !== "") push(current, { ...b, type: "user_message", text: e.body });
      continue;
    }

    // Rule 1, second half: a host without `prompt-submit` still tells us the prompt on
    // every entry, so a change — or a repeat after a `stop` — is where the turn opens.
    if (e.userPrompt !== "" && (turnEnded || (!openedBySubmit && e.userPrompt !== lastPrompt))) {
      const b = base(e);
      current = open(e.timestamp, `${b.id}-p`);
      openedBySubmit = false;
      lastPrompt = e.userPrompt;
      push(current, { ...b, id: `${b.id}-p`, type: "user_message", text: e.userPrompt });
    }

    const turn = here(e);
    const b = base(e);

    switch (event) {
      case "stop":
      case "agent-response":
      case "after-agent": {
        if (e.body !== "") {
          push(turn, { ...b, type: "assistant_text", text: e.body, state: "done", truncated: e.bodyTruncated === true });
        }
        if (event === "stop") {
          turn.endedAt = e.timestamp;
          turn.stopReason = "end_turn";
          turnEnded = true;
        }
        break;
      }
      case "tool-pre": {
        // A question is not a call with a sentence for a title: its options and their words have
        // nowhere to live on one, and a client re-parsing a title into buttons draws them wrong.
        if (e.questions !== undefined && e.questions.length > 0) {
          push(turn, {
            ...b,
            type: "question",
            questions: e.questions,
            ...(e.toolCallId === undefined ? {} : { toolCallId: e.toolCallId }),
          });
          break;
        }
        push(turn, toolCall(b, e, "in_progress"));
        break;
      }
      case "tool-post":
      case "tool-post-failed": {
        const status = event === "tool-post" ? "completed" : "failed";
        // A question settles here too, and it is the only way a cell with a terminal can say
        // what became of it: the operator answers or presses Esc at the keyboard, and the
        // runner writes the outcome to its own file. Without this the card never came down.
        const asked = openQuestion(turn, e.toolCallId);
        if (asked !== undefined) {
          if (status === "failed") asked.cancelled = true;
          else asked.answered = e.answers ?? {};
          break;
        }
        const pending = openCall(turn, e.title, e.toolCallId);
        if (pending === undefined) {
          push(turn, toolCall(b, e, status));
        } else {
          pending.status = status;
          if (pending.title === "" && e.toolTarget !== "") pending.title = e.toolTarget;
          const diff = diffOf(e, pending.title);
          if (diff !== undefined) pending.diff = diff;
        }
        break;
      }
      case "error": {
        push(turn, { ...b, type: "error", message: e.body !== "" ? e.body : e.toolTarget, recoverable: false });
        if (e.title === "Interrupted") {
          turn.endedAt = e.timestamp;
          turn.stopReason = "cancelled";
          turnEnded = true;
        }
        break;
      }
      case "notification":
      case "needs-input": {
        push(turn, { ...b, type: "status", state: "requires_action", ...(e.body !== "" ? { detail: e.body } : {}) });
        break;
      }
      case "session-start":
      case "before-agent":
        push(turn, { ...b, type: "status", state: "running" });
        break;
      case "session-end":
        push(turn, { ...b, type: "status", state: "ended" });
        break;
      default: {
        // A carrier with no content — the old `UserPromptSubmit` shape, whose prompt is
        // already the turn's `user_message` — draws nothing.
        const summary = e.toolTarget !== "" ? e.toolTarget : e.body;
        if (summary === "" && e.title === "") break;
        // An event with a tool-shaped title is a step this host has not named yet — the
        // rule Chat has always followed for an unknown `event` — so it keeps the shape a
        // step has (`tool_call`, kind `other`) and the phone draws it like any other.
        if (e.title !== "") {
          push(turn, toolCall(b, e, "completed"));
          break;
        }
        push(turn, { ...b, type: "unknown", rawType: e.event, summary });
      }
    }
  }

  return turns;
}

function toolCall(b: Omit<ToolCallPart, "type" | "toolCallId" | "toolName" | "title" | "kind" | "status" | "locations">, e: TranscriptEntry, status: ToolCallPart["status"]): ToolCallPart {
  const title = e.toolTarget !== "" ? e.toolTarget : e.body;
  const kind = toolKindOf(e.title);
  const part: ToolCallPart = {
    ...b,
    type: "tool_call",
    // The runner's own id when it reported one — that is what a result pairs against. The
    // part's id is the fallback for a hook drop, which carries none.
    toolCallId: e.toolCallId ?? b.id,
    toolName: e.title,
    title,
    kind,
    status,
    locations: kindNamesAFile(kind) && title !== "" ? [{ path: title }] : [],
  };
  const diff = diffOf(e, title);
  if (diff !== undefined) part.diff = diff;
  return part;
}

/** The last `in_progress` call for this tool name — or, when the result names no tool, the last one open at all. */
/**
 * The call this result answers — **by id when there is one**, by tool name otherwise.
 *
 * The name is a fallback, not the rule: a hook drop carries no id, and two concurrent `Bash`
 * calls are indistinguishable by name, so a result could settle the wrong one. An id cannot be
 * confused, and every result read from a runner's own file has one.
 */
function openCall(turn: Turn, toolName: string, toolCallId?: string): ToolCallPart | undefined {
  for (let i = turn.parts.length - 1; i >= 0; i--) {
    const p = turn.parts[i];
    if (p?.type !== "tool_call" || p.status !== "in_progress") continue;
    if (toolCallId !== undefined && p.toolCallId !== undefined) {
      if (p.toolCallId === toolCallId) return p;
      continue;
    }
    if (toolName === "" || toolName === "Tool" || p.toolName === toolName) return p;
  }
  return undefined;
}

/** The question this result settles. Only ever by id: a question has no tool name to fall back on. */
function openQuestion(turn: Turn, toolCallId?: string): QuestionPart | undefined {
  if (toolCallId === undefined) return undefined;
  for (let i = turn.parts.length - 1; i >= 0; i--) {
    const p = turn.parts[i];
    if (p?.type !== "question" || p.toolCallId !== toolCallId) continue;
    return p.answered === undefined && p.cancelled === undefined ? p : undefined;
  }
  return undefined;
}

/** Absent, not `+0 −0`, when the entry carried neither count. */
function diffOf(e: TranscriptEntry, path: string): ToolCallPart["diff"] | undefined {
  if (e.linesAdded === undefined && e.linesRemoved === undefined) return undefined;
  return {
    files: [{
      path,
      op: "modify",
      ...(e.linesAdded === undefined ? {} : { additions: e.linesAdded }),
      ...(e.linesRemoved === undefined ? {} : { deletions: e.linesRemoved }),
    }],
  };
}

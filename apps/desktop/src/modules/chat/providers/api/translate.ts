// Translates an OpenAI-compatible `/chat/completions` stream into provider-neutral ThreadEvents
// (#288). Runs inside the chat bridge, one translator per thread. Pure: the session feeds it the
// stream's JSON chunks and says when a turn starts and ends.
//
// What the stream looks like (DeepSeek, Sumopod, OpenRouter, Ollama's /v1):
// - SSE `data: {json}` lines, ending with `data: [DONE]`. Text in `choices[0].delta.content`.
// - Thinking in `delta.reasoning_content` (DeepSeek) or `delta.reasoning` (OpenRouter, Ollama), or
//   inline as a leading `<think>…</think>` in the content (models served raw, e.g. through Ollama).
// - With `stream_options.include_usage`, a last chunk with `usage` and no choices.
// - A failure mid-stream arrives as `data: {"error": {"message": …}}`.

import type { ThreadEvent, ThreadItem, TurnInput, TurnUsage } from "../../domain/thread-event";
import { asNum, asObj, asStr } from "../claude/read-json";

const OPEN = "<think>";
const CLOSE = "</think>";

/** Splits a leading `<think>…</think>` off streamed content, across chunk boundaries. */
export class ThinkSplitter {
  private mode: "start" | "think" | "text" = "start";
  private pending = "";

  push(chunk: string): { reasoning: string; text: string } {
    this.pending += chunk;
    let reasoning = "";
    let text = "";
    if (this.mode === "start") {
      const head = this.pending.trimStart();
      if (head.startsWith(OPEN)) {
        this.mode = "think";
        this.pending = head.slice(OPEN.length);
      } else if (OPEN.startsWith(head)) {
        return { reasoning, text };
      } else {
        this.mode = "text";
      }
    }
    if (this.mode === "think") {
      const end = this.pending.indexOf(CLOSE);
      if (end >= 0) {
        reasoning = this.pending.slice(0, end);
        this.pending = this.pending.slice(end + CLOSE.length).replace(/^\s+/, "");
        this.mode = "text";
      } else {
        // Hold back what could be the start of the closing tag.
        const keep = CLOSE.length - 1;
        reasoning = this.pending.slice(0, Math.max(0, this.pending.length - keep));
        this.pending = this.pending.slice(reasoning.length);
        return { reasoning, text };
      }
    }
    text = this.pending;
    this.pending = "";
    return { reasoning, text };
  }

  /** What is still held when the stream ends: unfinished thinking stays thinking. */
  flush(): { reasoning: string; text: string } {
    const rest = this.pending;
    this.pending = "";
    return this.mode === "think" ? { reasoning: rest, text: "" } : { reasoning: "", text: rest };
  }
}

/** Complete `data:` payloads in `buffer`, and the unfinished tail to keep. `[DONE]` is dropped. */
export function sseData(buffer: string): { data: string[]; rest: string } {
  const lines = buffer.split(/\r?\n/);
  const rest = lines.pop() ?? "";
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((payload) => payload.length > 0 && payload !== "[DONE]");
  return { data, rest };
}

/** "DeepSeek answered 401: Authentication Fails" from an error response's body. */
export function httpError(providerName: string, status: number, body: string): string {
  let detail = body.trim().slice(0, 300);
  try {
    const json = asObj(JSON.parse(body));
    detail = asStr(asObj(json?.error)?.message) ?? asStr(json?.error) ?? asStr(json?.message) ?? detail;
  } catch {
    // Not JSON: the body as it came.
  }
  return `${providerName} answered ${status}${detail ? `: ${detail}` : ""}`;
}

interface Open {
  id: string;
  kind: "agentMessage" | "reasoning";
  text: string;
}

export class ApiTranslator {
  /** Kept for the bridge's shared wiring; an API thread signs in with its provider's key. */
  requestedAuth = null;
  private turnId: string | null = null;
  private input: TurnInput | null = null;
  private interruptRequested = false;
  private usage: TurnUsage | null = null;
  private startedAt = 0;
  private think = new ThinkSplitter();
  private open: Open | null = null;
  private answer = "";
  private nextItem = 0;

  noteInput(input: TurnInput): void {
    this.input = input;
  }

  noteInterrupt(): void {
    this.interruptRequested = true;
  }

  // An API thread runs no tools, so nothing is ever asked.
  interactionRequested(): ThreadEvent[] {
    return [];
  }

  interactionResolved(): ThreadEvent[] {
    return [];
  }

  configured(model: string | null, hasKey: boolean, cwd: string | null): ThreadEvent[] {
    const authSource = hasKey ? "apiKey" : "unknown";
    return [{ type: "session/configured", providerSessionId: null, model, authSource, requestedAuth: authSource, cwd }];
  }

  turnStarted(turnId: string, now: number): ThreadEvent[] {
    this.turnId = turnId;
    this.startedAt = now;
    this.interruptRequested = false;
    this.usage = null;
    this.think = new ThinkSplitter();
    this.answer = "";
    const input = this.input;
    this.input = null;
    return [{ type: "turn/started", turnId, input }];
  }

  chunk(raw: unknown): ThreadEvent[] {
    const json = asObj(raw);
    if (!json || !this.turnId) return [];
    const usage = asObj(json.usage);
    if (usage) {
      this.usage = {
        inputTokens: asNum(usage.prompt_tokens) ?? 0,
        outputTokens: asNum(usage.completion_tokens) ?? 0,
        costUsd: null,
        durationMs: null,
      };
    }
    const choices = Array.isArray(json.choices) ? json.choices : [];
    const delta = asObj(asObj(choices[0])?.delta);
    if (!delta) return [];
    const out: ThreadEvent[] = [];
    const reasoning = asStr(delta.reasoning_content) ?? asStr(delta.reasoning);
    if (reasoning) out.push(...this.write("reasoning", reasoning));
    const content = asStr(delta.content);
    if (content) {
      const split = this.think.push(content);
      if (split.reasoning) out.push(...this.write("reasoning", split.reasoning));
      if (split.text) out.push(...this.write("agentMessage", split.text));
    }
    return out;
  }

  /** Closes the turn. `answer`: the text to keep in the conversation, if it finished. */
  turnEnded(error: string | null, now: number): { events: ThreadEvent[]; answer: string | null } {
    if (!this.turnId) return { events: [], answer: null };
    const out: ThreadEvent[] = [];
    const rest = this.think.flush();
    if (rest.reasoning) out.push(...this.write("reasoning", rest.reasoning));
    if (rest.text) out.push(...this.write("agentMessage", rest.text));
    const status = error ? "failed" : this.interruptRequested ? "interrupted" : "completed";
    out.push(...this.close(status));
    const usage = this.usage ? { ...this.usage, durationMs: now - this.startedAt } : null;
    out.push({ type: "turn/completed", turnId: this.turnId, status, error, usage, forkPoint: status === "completed" ? this.turnId : null });
    this.turnId = null;
    // An interrupted answer still happened; the model sees what it got to say.
    return { events: out, answer: status === "failed" ? null : this.answer };
  }

  end(error: string | null): ThreadEvent[] {
    const { events } = this.turnEnded(error, Date.now());
    return [...events, { type: "session/ended", error }];
  }

  private write(kind: Open["kind"], delta: string): ThreadEvent[] {
    const out: ThreadEvent[] = [];
    if (this.open?.kind !== kind) {
      out.push(...this.close("completed"));
      // Leading whitespace after a thought is noise in the answer.
      if (kind === "agentMessage" && delta.trim().length === 0) return out;
      this.nextItem += 1;
      this.open = { id: `${this.turnId}-${kind}-${this.nextItem}`, kind, text: "" };
      out.push({ type: "item/started", turnId: this.turnId!, item: { id: this.open.id, kind, status: "running", text: "" } });
    }
    this.open!.text += delta;
    if (kind === "agentMessage") this.answer += delta;
    out.push({ type: "item/delta", turnId: this.turnId!, itemId: this.open!.id, delta });
    return out;
  }

  private close(status: ThreadItem["status"]): ThreadEvent[] {
    const open = this.open;
    if (!open) return [];
    this.open = null;
    return [{ type: "item/completed", turnId: this.turnId!, item: { id: open.id, kind: open.kind, status, text: open.text } }];
  }
}

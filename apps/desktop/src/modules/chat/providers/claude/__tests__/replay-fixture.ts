// Replays a recorded bridge transcript (../__fixtures__/<name>.jsonl, written by
// scripts/chat-bridge/record-fixtures.ts) through the translator, the same way the bridge wires
// it: inputs first, raw SDK messages in order, approvals answered by `decide`.

import { readFileSync } from "node:fs";
import path from "node:path";

import type { ThreadEventEnvelope, TurnInput } from "../../../domain/thread-event";
import { ClaudeTranslator } from "../translate";

type Decision = { behavior: "allow" } | { behavior: "deny"; message: string };

interface FixtureLine {
  method: "thread/raw" | "thread/ended" | "interaction/request";
  id?: string;
  params: Record<string, unknown> & { event?: unknown; toolName?: string };
}

export function readFixture(name: string): FixtureLine[] {
  const file = path.resolve(__dirname, "../__fixtures__", `${name}.jsonl`);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as FixtureLine);
}

export interface ReplayOptions {
  inputs: TurnInput[];
  decide?: (toolName: string) => Decision;
  // Called before the raw message with this 1-based index is translated.
  before?: (index: number, translator: ClaudeTranslator) => void;
}

export function replayFixture(name: string, options: ReplayOptions): ThreadEventEnvelope[] {
  const threadId = `fixture-${name}`;
  let ids = 0;
  const translator = new ClaudeTranslator({ newId: () => `turn-${++ids}` });
  for (const input of options.inputs) translator.noteInput(input);

  const envelopes: ThreadEventEnvelope[] = [];
  const emit = (events: ReturnType<ClaudeTranslator["translate"]>) => {
    for (const event of events) envelopes.push({ threadId, seq: envelopes.length + 1, at: envelopes.length * 10, event });
  };

  let rawIndex = 0;
  for (const line of readFixture(name)) {
    if (line.method === "thread/raw") {
      options.before?.(++rawIndex, translator);
      emit(translator.translate(line.params.event));
    } else if (line.method === "interaction/request") {
      const params = line.params as { toolName: string; toolUseId: string | null; input: unknown; blockedPath: string | null };
      const id = line.id ?? "interaction";
      emit(translator.interactionRequested(id, params));
      emit(translator.interactionResolved(id, options.decide?.(params.toolName) ?? { behavior: "allow" }));
    } else if (line.method === "thread/ended") {
      emit(translator.end((line.params.error as string | null) ?? null));
    }
  }
  return envelopes;
}

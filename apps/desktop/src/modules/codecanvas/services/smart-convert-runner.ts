import type { AcceptanceCriterion, SmartConvertDraft, TaskClass, TaskWhen } from "../types/canvas";

/** The CLIs `smart_convert_note` can run; the API runner is left out. */
export const SMART_CONVERT_RUNNERS = ["claude", "codex"] as const;
export type SmartConvertRunner = (typeof SMART_CONVERT_RUNNERS)[number];

/** `model` "" = the CLI's own default. */
export async function runSmartConvert(runner: SmartConvertRunner, content: string, model: string): Promise<string> {
  const { smartConvertNote } = await import("@/lib/tauri-api");
  return smartConvertNote(content, model, runner);
}

export function buildSmartConvertPrompt(content: string): string {
  return (
    "Extract a structured task from the following note. Return ONLY valid JSON, no markdown fences.\n\n" +
    "Schema:\n" +
    '{\n  "title": "concise task label (max 80 chars)",\n' +
    '  "intent": "clarified goal in 1-3 sentences — what must be achieved and why",\n' +
    '  "acceptanceCriteria": ["verifiable condition 1", "verifiable condition 2"],\n' +
    '  "taskClass": "quick | needs-research | deep-focus | benchmark",\n' +
    '  "when": "urgent | this-week | this-month | whenever",\n' +
    '  "subtasks": []\n}\n\n' +
    "taskClass: quick=<2h clear steps, needs-research=requires investigation first, " +
    "deep-focus=>4h complex work, benchmark=measuring/comparing quality or performance\n" +
    "when: urgent=blocking/imminent deadline, this-week=address soon, " +
    "this-month=flexible timing, whenever=no time pressure\n\n" +
    `Note:\n${content}`
  );
}

const VALID_TASK_CLASSES = new Set<string>(["quick", "needs-research", "deep-focus", "benchmark"]);
const VALID_WHEN_VALUES = new Set<string>(["urgent", "this-week", "this-month", "whenever"]);
const MAX_CRITERIA = 8;
const MAX_SUBTASKS = 10;

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
  if (fenced) return fenced;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function cleanString(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

function cleanStringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanString(item)).filter(Boolean).slice(0, limit);
}

export function parseSmartConvertDraft(raw: string): SmartConvertDraft {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>;
  } catch {
    throw new Error("The answer was not a task. Try again.");
  }
  const criteria: AcceptanceCriterion[] = cleanStringList(parsed.acceptanceCriteria, MAX_CRITERIA).map((text) => ({
    id: crypto.randomUUID(),
    text,
    done: false,
  }));
  return {
    title: cleanString(parsed.title, "Untitled Task").slice(0, 80) || "Untitled Task",
    intent: cleanString(parsed.intent),
    acceptanceCriteria: criteria,
    taskClass: VALID_TASK_CLASSES.has(String(parsed.taskClass))
      ? (parsed.taskClass as TaskClass)
      : "quick",
    when: VALID_WHEN_VALUES.has(String(parsed.when))
      ? (parsed.when as TaskWhen)
      : "whenever",
    subtasks: cleanStringList(parsed.subtasks, MAX_SUBTASKS),
  };
}

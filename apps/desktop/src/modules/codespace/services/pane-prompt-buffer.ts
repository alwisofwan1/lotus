import type { CellBus } from "@/modules/codespace/services/bridge/cell-event-bus";

const MAX_PROMPTS_PER_PANE = 8;
const MAX_PROMPT_LENGTH = 200;
const MIN_PROMPT_LENGTH = 2;

const buffers = new Map<string, string[]>();

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_CHARS_PATTERN = /[\x00-\x08\x0b-\x1f\x7f]/g;

function normalisePrompt(raw: string): string | null {
  const stripped = raw
    .replace(ANSI_PATTERN, "")
    .replace(CONTROL_CHARS_PATTERN, "")
    .trim();
  if (stripped.length < MIN_PROMPT_LENGTH) return null;
  return stripped.length > MAX_PROMPT_LENGTH
    ? stripped.slice(0, MAX_PROMPT_LENGTH)
    : stripped;
}

export function recordPanePrompt(paneId: string, prompt: string): void {
  const cleaned = normalisePrompt(prompt);
  if (!cleaned) return;
  let queue = buffers.get(paneId);
  if (!queue) {
    queue = [];
    buffers.set(paneId, queue);
  }
  queue.push(cleaned);
  if (queue.length > MAX_PROMPTS_PER_PANE) {
    queue.splice(0, queue.length - MAX_PROMPTS_PER_PANE);
  }
}

export function seedPanePrompt(paneId: string, prompt: string): void {
  recordPanePrompt(paneId, prompt);
}

export function getPanePromptTail(
  paneId: string,
  n: number = MAX_PROMPTS_PER_PANE,
): string {
  const queue = buffers.get(paneId);
  if (!queue || queue.length === 0) return "";
  const limit = Math.max(0, Math.min(n, queue.length));
  return queue.slice(queue.length - limit).join("\n");
}

export function getPanePromptCount(paneId: string): number {
  return buffers.get(paneId)?.length ?? 0;
}

export function clearPanePrompt(paneId: string): void {
  buffers.delete(paneId);
}

export function clearAllPanePrompts(): void {
  buffers.clear();
}

export function subscribePanePromptBuffer(bus: CellBus): () => void {
  const offTerminal = bus.on("terminal:input", (event) => {
    if (!event.submitted) return;
    const text = event.promptText ?? "";
    if (!text) return;
    recordPanePrompt(event.paneId, text);
  });
  const offBridge = bus.on("bridge:input", (event) => {
    recordPanePrompt(event.paneId, event.prompt);
  });
  const offExit = bus.on("terminal:exited", (event) => {
    clearPanePrompt(event.paneId);
  });
  return () => {
    offTerminal();
    offBridge();
    offExit();
  };
}

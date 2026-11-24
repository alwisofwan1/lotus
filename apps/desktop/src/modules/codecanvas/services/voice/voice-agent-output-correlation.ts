export interface VoiceAgentFirstOutputEvent {
  turnId: string;
  elapsedSinceEnterMs: number;
}

export interface VoiceAgentOutputTimeoutEvent {
  turnId: string;
}

export interface VoiceAgentOutputCorrelationInput {
  agentId: string;
  turnId: string;
  /** Kept only in memory to suppress the terminal's prompt echo. */
  submittedText: string;
  onFirstOutput: (event: VoiceAgentFirstOutputEvent) => void;
  onTimeout: (event: VoiceAgentOutputTimeoutEvent) => void;
}

export interface VoiceAgentOutputCorrelationRegistry {
  /** One pending correlation per agent keeps concurrent response attribution unambiguous. */
  arm(input: VoiceAgentOutputCorrelationInput): boolean;
  /** Make output eligible only after the native Enter write is acknowledged. */
  confirmEnter(turnId: string): boolean;
  cancel(turnId: string): void;
  noteOutput(agentId: string, chunk: string): void;
}

export interface VoiceAgentOutputCorrelationClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): () => void;
}

const realClock: VoiceAgentOutputCorrelationClock = {
  now: () => performance.now(),
  setTimeout(callback, ms) {
    const timer = globalThis.setTimeout(callback, ms);
    return () => globalThis.clearTimeout(timer);
  },
};

const ANSI_SEQUENCE = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g;
const CONTROL_CHARACTER = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function visibleText(value: string): string {
  return value
    .replace(ANSI_SEQUENCE, "")
    .replace(CONTROL_CHARACTER, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isStandbyChromeOnly(visible: string): boolean {
  const remainder = visible
    .toLocaleLowerCase()
    .replace(/\? for shortcuts/g, "")
    .replace(/bypass permissions on/g, "")
    .replace(/shift\+tab to cycle/g, "")
    .replace(/[·|—–-]/g, "")
    .trim();
  return remainder.length === 0;
}

export function isMeaningfulAgentFirstOutput(chunk: string, submittedText: string): boolean {
  const visible = visibleText(chunk);
  if (!visible || isStandbyChromeOnly(visible)) return false;
  const prompt = visibleText(submittedText);
  if (!prompt) return true;
  if (prompt.toLocaleLowerCase().includes(visible.toLocaleLowerCase())) return false;
  return visible.replace(prompt, "").trim().length > 0;
}

type PendingCorrelation = VoiceAgentOutputCorrelationInput & {
  enteredAt?: number;
  cancelTimeout?: () => void;
};

export function createVoiceAgentOutputCorrelationRegistry(
  options: { clock?: VoiceAgentOutputCorrelationClock; timeoutMs?: number } = {},
): VoiceAgentOutputCorrelationRegistry {
  const clock = options.clock ?? realClock;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const byAgent = new Map<string, PendingCorrelation>();
  const byTurn = new Map<string, PendingCorrelation>();

  const remove = (pending: PendingCorrelation) => {
    pending.cancelTimeout?.();
    pending.cancelTimeout = undefined;
    if (byAgent.get(pending.agentId) === pending) byAgent.delete(pending.agentId);
    if (byTurn.get(pending.turnId) === pending) byTurn.delete(pending.turnId);
  };

  return {
    arm(input) {
      if (byAgent.has(input.agentId) || byTurn.has(input.turnId)) return false;
      const pending: PendingCorrelation = { ...input };
      byAgent.set(input.agentId, pending);
      byTurn.set(input.turnId, pending);
      return true;
    },
    confirmEnter(turnId) {
      const pending = byTurn.get(turnId);
      if (!pending || pending.enteredAt !== undefined) return false;
      pending.enteredAt = clock.now();
      pending.cancelTimeout = clock.setTimeout(() => {
        remove(pending);
        pending.onTimeout({ turnId: pending.turnId });
      }, timeoutMs);
      return true;
    },
    cancel(turnId) {
      const pending = byTurn.get(turnId);
      if (pending) remove(pending);
    },
    noteOutput(agentId, chunk) {
      const pending = byAgent.get(agentId);
      if (!pending || pending.enteredAt === undefined) return;
      if (!isMeaningfulAgentFirstOutput(chunk, pending.submittedText)) return;
      const elapsedSinceEnterMs = Math.max(0, Math.round(clock.now() - pending.enteredAt));
      remove(pending);
      pending.onFirstOutput({ turnId: pending.turnId, elapsedSinceEnterMs });
    },
  };
}

export const voiceAgentOutputCorrelationRegistry = createVoiceAgentOutputCorrelationRegistry();

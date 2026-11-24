/**
 * Tracks which browser terminals an agent is actively driving (a snapshot / click / type / search is
 * in-flight), so the paired Browser Node can show a "an agent is using this browser" badge — the web
 * analogue of the iOS Simulator pane's "Claude is using this device". Rust emits
 * `canvas://browser-activity` {terminalId, active}; the bridge hook feeds this store.
 *
 * Module-level store (survives node remounts), read via useSyncExternalStore. Keyed by the terminal
 * id the agent/handler used — which is the paired Browser Node's `parentTerminalId`.
 */

type Listener = () => void;

const activeTerminals = new Set<string>();
const safetyTimers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<Listener>();

/**
 * Safety net: if a trailing `active:false` is ever lost (event drop, crash mid-capture), auto-clear so
 * the badge can't stick on forever. Deliberately longer than any single capture budget (snapshot ≤10s,
 * screenshot ≤4s) so it never clears mid-operation — the explicit `false` is the normal clear.
 */
const SAFETY_CLEAR_MS = 20_000;

function emit(): void {
  listeners.forEach((listener) => listener());
}

function clearSafetyTimer(terminalId: string): void {
  const timer = safetyTimers.get(terminalId);
  if (timer) {
    clearTimeout(timer);
    safetyTimers.delete(terminalId);
  }
}

/** Set (or clear) whether an agent is actively driving the browser paired with `terminalId`. */
export function setCanvasBrowserActivity(terminalId: string, active: boolean): void {
  if (!terminalId) return;
  clearSafetyTimer(terminalId);
  if (active) {
    activeTerminals.add(terminalId);
    safetyTimers.set(
      terminalId,
      setTimeout(() => setCanvasBrowserActivity(terminalId, false), SAFETY_CLEAR_MS),
    );
  } else {
    activeTerminals.delete(terminalId);
  }
  emit();
}

export function getCanvasBrowserActivity(terminalId: string): boolean {
  return activeTerminals.has(terminalId);
}

export function subscribeCanvasBrowserActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: wipe all state + timers. */
export function __resetCanvasBrowserActivityForTests(): void {
  activeTerminals.clear();
  safetyTimers.forEach((timer) => clearTimeout(timer));
  safetyTimers.clear();
  listeners.clear();
}

type TerminalWebglPolicy = "auto" | "force" | "off" | "smooth-active-pane";

export interface TerminalWebglActivationContext {
  /** True only for the focused, visible terminal pane selected for accelerated rendering. */
  activePaneEligible?: boolean;
  /**
   * Which surface is asking. Defaults to CodeSpace.
   *
   * CodeCanvas is exempt from the blanket Tauri disable below: that guard is about CodeSpace's
   * pane lifecycle (hidden by workspace switches, detached, re-shown), which strands GPU
   * canvases. A canvas node mounts one terminal and keeps it for the node's lifetime.
   *
   * Canvas has the opposite problem — count. A board can hold twenty agent nodes and WKWebView
   * caps live WebGL contexts, so canvas is held to smooth-active-pane semantics: accelerate the
   * focused node, leave the rest on the DOM renderer.
   *
   * `codespace-pooled` is the terminal-v2 pooled slot, and it is exempt for a reason the other two
   * are not: it is the one surface where the lifecycle the guard warns about is HANDLED. A pooled
   * slot attaches to at most one pane, gives its GPU context back the moment it parks
   * (`terminal-v2-pooled-renderer-acceleration.ts`), and the pool caps how many exist at once.
   * Verified in the native window on 2026-09-20 — banner, box frames and the context meter drawn
   * by xterm instead of the font, held across splits, workspace switches, resizes and
   * minimise/restore, with no clipped rows or ghost canvases. `codespace` (the legacy runtime)
   * keeps the conservative default: its lifecycle is the untested one.
   */
  surface?: "codespace" | "codespace-pooled" | "canvas";
}

const WEBGL_POLICY_STORAGE_KEY = "lotus.terminal.webgl.policy";
const WEBGL_BACKOFF_STORAGE_KEY = "lotus.terminal.webgl.disabledUntil";
const WEBGL_CONTEXT_LOSS_BACKOFF_MS = 24 * 60 * 60 * 1000;
const SOFTWARE_WEBGL_RENDERER_RE = /swiftshader|llvmpipe|software|mesa offscreen|softpipe|warp|basic render/i;

let terminalWebglMemoryBackoffUntil = 0;

function parseTerminalWebglPolicy(value: string | null | undefined): TerminalWebglPolicy | null {
  return value === "auto" || value === "force" || value === "off" || value === "smooth-active-pane" ? value : null;
}

function safeLocalStorageGet(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string): boolean {
  try {
    if (typeof window === "undefined") return false;
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeLocalStorageRemove(key: string): void {
  try {
    if (typeof window !== "undefined") window.localStorage.removeItem(key);
  } catch {
    // Best-effort cleanup only.
  }
}

function readTerminalWebglPolicy(): TerminalWebglPolicy {
  const storedPolicy = safeLocalStorageGet(WEBGL_POLICY_STORAGE_KEY);
  const envPolicy = typeof process === "undefined"
    ? undefined
    : process.env.NEXT_PUBLIC_LOTUS_TERMINAL_WEBGL ?? process.env.LOTUS_TERMINAL_WEBGL;
  return parseTerminalWebglPolicy(storedPolicy) ?? parseTerminalWebglPolicy(envPolicy) ?? "auto";
}

function isTerminalWebglBackoffActive(): boolean {
  if (terminalWebglMemoryBackoffUntil > Date.now()) return true;
  terminalWebglMemoryBackoffUntil = 0;

  const disabledUntil = Number(safeLocalStorageGet(WEBGL_BACKOFF_STORAGE_KEY));
  if (!Number.isFinite(disabledUntil) || disabledUntil <= 0) {
    safeLocalStorageRemove(WEBGL_BACKOFF_STORAGE_KEY);
    return false;
  }
  if (disabledUntil <= Date.now()) {
    safeLocalStorageRemove(WEBGL_BACKOFF_STORAGE_KEY);
    return false;
  }
  return true;
}

function getWebglRendererName(context: WebGL2RenderingContext): string | null {
  try {
    const debugInfo = context.getExtension("WEBGL_debug_renderer_info");
    if (debugInfo) {
      return String(context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL));
    }
    return String(context.getParameter(context.RENDERER));
  } catch {
    return null;
  }
}

function hasUsableWebgl2Capability(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2", {
      antialias: false,
      depth: false,
      preserveDrawingBuffer: false,
    });
    if (!context) return false;
    const renderer = getWebglRendererName(context);
    return !renderer || !SOFTWARE_WEBGL_RENDERER_RE.test(renderer);
  } catch {
    return false;
  }
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function shouldDisableAutoWebglForRuntime(): boolean {
  // xterm's WebGL renderer is fast in browsers but brittle inside desktop
  // webviews under CodeSpace's multi-pane lifecycle: panes are frequently
  // resized, hidden via workspace switches, detached, and re-shown. In Tauri
  // this can leave stale GPU canvases, clipped rows, or horizontal artifacts.
  // Keep `auto` conservative for production; diagnostics can still opt in via
  // localStorage/env policy `force`.
  return isTauriRuntime();
}

export function recordTerminalWebglContextLoss(): void {
  const disabledUntil = Date.now() + WEBGL_CONTEXT_LOSS_BACKOFF_MS;
  if (!safeLocalStorageSet(WEBGL_BACKOFF_STORAGE_KEY, String(disabledUntil))) {
    terminalWebglMemoryBackoffUntil = disabledUntil;
  }
}

export function shouldActivateTerminalWebgl(context: TerminalWebglActivationContext = {}): boolean {
  const policy = readTerminalWebglPolicy();
  if (policy === "off") return false;
  if (policy === "force") return true;

  // Canvas and the pooled CodeSpace slot ride the same focused-pane-only rule as
  // smooth-active-pane, whatever the stored policy says: it is the rule that bounds live GPU
  // contexts, on a board full of agent nodes and in a workspace full of panes alike.
  const activePaneSmoothMode = policy === "smooth-active-pane"
    || context.surface === "canvas"
    || context.surface === "codespace-pooled";
  if (shouldDisableAutoWebglForRuntime() && !activePaneSmoothMode) return false;
  if (activePaneSmoothMode && !context.activePaneEligible) return false;

  return !isTerminalWebglBackoffActive() && hasUsableWebgl2Capability();
}

export function shouldDemoteTerminalWebglForEligibility(context: TerminalWebglActivationContext = {}): boolean {
  const eligibilityGated = readTerminalWebglPolicy() === "smooth-active-pane"
    || context.surface === "canvas"
    || context.surface === "codespace-pooled";
  return eligibilityGated && !context.activePaneEligible;
}

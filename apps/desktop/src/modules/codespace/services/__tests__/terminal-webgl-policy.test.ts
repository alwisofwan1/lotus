import { beforeEach, describe, expect, it, vi } from "vitest";

function setTauriRuntime(enabled: boolean) {
  if (enabled) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).__TAURI_INTERNALS__;
}

function mockUsableWebgl2() {
  const context = {
    RENDERER: 0x1F01,
    getExtension: vi.fn(() => null),
    getParameter: vi.fn(() => "Apple GPU"),
  };
  return vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as RenderingContext);
}

describe("terminal-webgl-policy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    window.localStorage.clear();
    setTauriRuntime(false);
    delete process.env.NEXT_PUBLIC_LOTUS_TERMINAL_WEBGL;
    delete process.env.LOTUS_TERMINAL_WEBGL;
  });

  it("disables automatic WebGL in Tauri desktop even when WebGL2 is available", async () => {
    setTauriRuntime(true);
    mockUsableWebgl2();

    const { shouldActivateTerminalWebgl } = await import("../terminal-webgl-policy");

    expect(shouldActivateTerminalWebgl()).toBe(false);
  });

  it("accelerates an ATTACHED pooled CodeSpace slot in Tauri, where the legacy surface stays off", async () => {
    // The blanket Tauri disable is about a pane lifecycle that strands GPU canvases. The pooled
    // slot is the one surface that hands its context back when it parks, and it was verified in
    // the native window on 2026-09-20 — so it rides the focused-pane rule instead of the disable.
    setTauriRuntime(true);
    mockUsableWebgl2();

    const { shouldActivateTerminalWebgl } = await import("../terminal-webgl-policy");

    expect(shouldActivateTerminalWebgl({ surface: "codespace-pooled", activePaneEligible: true })).toBe(true);
    expect(shouldActivateTerminalWebgl({ surface: "codespace-pooled", activePaneEligible: false })).toBe(false);
    expect(shouldActivateTerminalWebgl({ surface: "codespace", activePaneEligible: true })).toBe(false);
  });

  it("lets an explicit off policy refuse the pooled slot too", async () => {
    setTauriRuntime(true);
    mockUsableWebgl2();
    window.localStorage.setItem("lotus.terminal.webgl.policy", "off");

    const { shouldActivateTerminalWebgl } = await import("../terminal-webgl-policy");

    expect(shouldActivateTerminalWebgl({ surface: "codespace-pooled", activePaneEligible: true })).toBe(false);
  });

  it("keeps the context-loss backoff over the pooled slot", async () => {
    setTauriRuntime(true);
    mockUsableWebgl2();
    window.localStorage.setItem("lotus.terminal.webgl.disabledUntil", String(Date.now() + 60_000));

    const { shouldActivateTerminalWebgl } = await import("../terminal-webgl-policy");

    expect(shouldActivateTerminalWebgl({ surface: "codespace-pooled", activePaneEligible: true })).toBe(false);
  });

  it("demotes a pooled slot that stopped being the attached one", async () => {
    setTauriRuntime(true);

    const { shouldDemoteTerminalWebglForEligibility } = await import("../terminal-webgl-policy");

    expect(shouldDemoteTerminalWebglForEligibility({ surface: "codespace-pooled", activePaneEligible: false })).toBe(true);
    expect(shouldDemoteTerminalWebglForEligibility({ surface: "codespace-pooled", activePaneEligible: true })).toBe(false);
  });

  it("still allows explicit force policy in Tauri for diagnostics", async () => {
    setTauriRuntime(true);
    window.localStorage.setItem("lotus.terminal.webgl.policy", "force");

    const { shouldActivateTerminalWebgl } = await import("../terminal-webgl-policy");

    expect(shouldActivateTerminalWebgl()).toBe(true);
  });

  it("allows Tauri WebGL only for the focused active pane in smooth-active-pane mode", async () => {
    setTauriRuntime(true);
    mockUsableWebgl2();
    window.localStorage.setItem("lotus.terminal.webgl.policy", "smooth-active-pane");

    const { shouldActivateTerminalWebgl } = await import("../terminal-webgl-policy");

    expect(shouldActivateTerminalWebgl({ activePaneEligible: false })).toBe(false);
    expect(shouldActivateTerminalWebgl({ activePaneEligible: true })).toBe(true);
  });

  it("only requests eligibility-based demotion in smooth-active-pane mode", async () => {
    const { shouldDemoteTerminalWebglForEligibility } = await import("../terminal-webgl-policy");

    expect(shouldDemoteTerminalWebglForEligibility({ activePaneEligible: false })).toBe(false);

    window.localStorage.setItem("lotus.terminal.webgl.policy", "smooth-active-pane");
    expect(shouldDemoteTerminalWebglForEligibility({ activePaneEligible: false })).toBe(true);
    expect(shouldDemoteTerminalWebglForEligibility({ activePaneEligible: true })).toBe(false);
  });

  it("keeps browser auto WebGL enabled when the renderer is usable", async () => {
    mockUsableWebgl2();

    const { shouldActivateTerminalWebgl } = await import("../terminal-webgl-policy");

    expect(shouldActivateTerminalWebgl()).toBe(true);
  });
});

/**
 * CodeCanvas surface (plans/canvas-terminal-opaque-floor).
 *
 * The blanket Tauri disable above exists for CodeSpace's pane lifecycle — panes get hidden by
 * workspace switches, detached, and re-shown, which strands GPU canvases. Canvas nodes do not
 * live that way: one terminal per node, mounted for the node's lifetime.
 *
 * What canvas DOES have is count. A board can hold twenty agent nodes, and WKWebView caps live
 * WebGL contexts — hand one to every node and the budget blows, xterm silently falls back to the
 * DOM renderer, and context-loss thrash makes things worse than before the change. So canvas
 * gets smooth-active-pane semantics: the focused node is accelerated, the rest stay on DOM.
 */
describe("terminal-webgl-policy — canvas surface", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    window.localStorage.clear();
    setTauriRuntime(true);
    delete process.env.NEXT_PUBLIC_LOTUS_TERMINAL_WEBGL;
    delete process.env.LOTUS_TERMINAL_WEBGL;
  });

  it("accelerates the focused canvas node in Tauri, where codespace stays disabled", async () => {
    mockUsableWebgl2();
    const { shouldActivateTerminalWebgl } = await import("../terminal-webgl-policy");

    expect(shouldActivateTerminalWebgl({ surface: "canvas", activePaneEligible: true })).toBe(true);
    // Same runtime, same policy — the codespace surface keeps its documented behaviour.
    expect(shouldActivateTerminalWebgl({ activePaneEligible: true })).toBe(false);
  });

  it("leaves unfocused canvas nodes on the DOM renderer to bound live GPU contexts", async () => {
    mockUsableWebgl2();
    const { shouldActivateTerminalWebgl } = await import("../terminal-webgl-policy");

    expect(shouldActivateTerminalWebgl({ surface: "canvas", activePaneEligible: false })).toBe(false);
  });

  it("still obeys an explicit off policy", async () => {
    mockUsableWebgl2();
    window.localStorage.setItem("lotus.terminal.webgl.policy", "off");
    const { shouldActivateTerminalWebgl } = await import("../terminal-webgl-policy");

    expect(shouldActivateTerminalWebgl({ surface: "canvas", activePaneEligible: true })).toBe(false);
  });

  it("still honours the context-loss backoff", async () => {
    mockUsableWebgl2();
    const { shouldActivateTerminalWebgl, recordTerminalWebglContextLoss } = await import(
      "../terminal-webgl-policy"
    );

    recordTerminalWebglContextLoss();
    expect(shouldActivateTerminalWebgl({ surface: "canvas", activePaneEligible: true })).toBe(false);
  });

  it("still refuses a software renderer", async () => {
    // SwiftShader/llvmpipe on the CPU is slower than the DOM renderer it would replace.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      RENDERER: 0x1f01,
      getExtension: vi.fn(() => null),
      getParameter: vi.fn(() => "SwiftShader"),
    } as unknown as RenderingContext);
    const { shouldActivateTerminalWebgl } = await import("../terminal-webgl-policy");

    expect(shouldActivateTerminalWebgl({ surface: "canvas", activePaneEligible: true })).toBe(false);
  });

  it("demotes an unfocused canvas node so a losing pane hands its context back", async () => {
    const { shouldDemoteTerminalWebglForEligibility } = await import("../terminal-webgl-policy");

    expect(shouldDemoteTerminalWebglForEligibility({ surface: "canvas", activePaneEligible: false })).toBe(true);
    expect(shouldDemoteTerminalWebglForEligibility({ surface: "canvas", activePaneEligible: true })).toBe(false);
  });
});

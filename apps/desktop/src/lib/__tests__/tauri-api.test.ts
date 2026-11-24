import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

describe("tauri-api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("cancels the exact native NL request when its signal aborts", async () => {
    (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    let finish!: (text: string) => void;
    mockInvoke.mockImplementation((command) => command === "nl_complete"
      ? new Promise<string>((resolve) => { finish = resolve; }) : Promise.resolve());
    const { nlComplete } = await import("../tauri-api");
    const owner = new AbortController();
    const pending = nlComplete("polish this", undefined, owner.signal);
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("nl_complete", expect.any(Object)));
    const args = mockInvoke.mock.calls.find(([command]) => command === "nl_complete")![1];
    owner.abort();
    finish("late result");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("nl_cancel", { requestId: args.requestId }));
    expect(args.requestId).toEqual(expect.any(String));
  });

  it("uses Tauri IPC when running inside the desktop app", async () => {
    (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    mockInvoke.mockResolvedValue(undefined);

    const { openNewWindow } = await import("../tauri-api");

    await openNewWindow();

    expect(mockInvoke).toHaveBeenCalledWith("open_new_window", { route: "/" });
  });

  it("falls back to opening a browser tab outside Tauri", async () => {
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);

    const { openNewWindow } = await import("../tauri-api");

    await openNewWindow();

    expect(openSpy).toHaveBeenCalledWith("/", "_blank", "noopener,noreferrer");
    expect(mockInvoke).not.toHaveBeenCalled();

    openSpy.mockRestore();
  });

  it("preserves the requested route for Tauri and browser fallback", async () => {
    mockInvoke.mockResolvedValue(undefined);
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const { openNewWindow } = await import("../tauri-api");

    (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    await openNewWindow("/teams");
    expect(mockInvoke).toHaveBeenCalledWith("open_new_window", { route: "/teams" });

    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    await openNewWindow("/settings");
    expect(openSpy).toHaveBeenCalledWith("/settings", "_blank", "noopener,noreferrer");

    openSpy.mockRestore();
  });

  it("sends structured decoder context through the STT trust boundary", async () => {
    (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    mockInvoke.mockResolvedValue({ text: "Halo Lotus", detectedLanguages: ["id"] });
    const { sttTranscribe } = await import("../tauri-api");
    const context = {
      prompt: "Technical dictation for a coding agent.",
      keywords: ["Lotus", "AGENTS.md"],
      languages: ["id", "en"],
    };

    await expect(sttTranscribe("openai", "QQ==", "audio/webm", context)).resolves.toEqual({
      text: "Halo Lotus",
      detectedLanguages: ["id"],
    });
    expect(mockInvoke).toHaveBeenCalledWith("stt_transcribe", {
      providerId: "openai",
      audioBase64: "QQ==",
      mime: "audio/webm",
      context,
    });
  });

  it("opens path references through the editor IPC command in Tauri", async () => {
    (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    mockInvoke.mockResolvedValue(undefined);

    const { openPathInEditor } = await import("../tauri-api");

    await openPathInEditor("src/app/page.tsx", "/workspace/project", 12, 3);

    expect(mockInvoke).toHaveBeenCalledWith("open_path_in_editor", {
      path: "src/app/page.tsx",
      cwd: "/workspace/project",
      line: 12,
      column: 3,
    });
  });

  it("returns editor availability through Tauri IPC and browser fallback", async () => {
    mockInvoke.mockResolvedValue({ vscode: true, cursor: false, antigravity: true, antigravityApp: true });
    const { getEditorAvailability } = await import("../tauri-api");

    (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    await expect(getEditorAvailability()).resolves.toEqual({ vscode: true, cursor: false, antigravity: true, antigravityApp: true });

    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    await expect(getEditorAvailability()).resolves.toEqual({ vscode: false, cursor: false, antigravity: false, antigravityApp: false });
  });

  it("cancels native TTS with the same request id when its signal aborts", async () => {
    (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    let finishSynthesis!: () => void;
    mockInvoke.mockImplementation((command: string) => {
      if (command === "tts_synthesize") {
        return new Promise((resolve) => {
          finishSynthesis = () => resolve({ audioBase64: "QQ==", mime: "audio/mpeg" });
        });
      }
      return Promise.resolve(command === "tts_cancel_synthesis");
    });
    const { ttsSynthesize } = await import("../tauri-api");
    const controller = new AbortController();

    const synthesis = ttsSynthesize("openai", "hello", { signal: controller.signal });
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("tts_synthesize", expect.any(Object));
    });
    const synthArgs = mockInvoke.mock.calls.find(([command]) => command === "tts_synthesize")?.[1] as {
      requestId: string;
    };
    controller.abort();
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("tts_cancel_synthesis", {
        requestId: synthArgs.requestId,
      });
    });
    finishSynthesis();
    await synthesis;
  });

  it("does not start native TTS when its signal is already aborted", async () => {
    (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    const { ttsSynthesize } = await import("../tauri-api");
    const controller = new AbortController();
    controller.abort();

    await expect(
      ttsSynthesize("openai", "stale", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});

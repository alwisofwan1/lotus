import { describe, expect, it, vi } from "vitest";
import { createTerminalV2NativeOutputHandler } from "../terminal-v2-native-output";

const baseResult = {
  visibleData: "hello",
  cwdUpdates: [],
  osc133Events: [],
  exitCode: null,
  outputRoute: "visible" as const,
  nextTrustPromptSeen: false,
  autoTrustResponse: null,
  rememberTrustedCwd: false,
  resizeAfterTrust: false,
  scheduleSuggestionLayout: false,
};

describe("createTerminalV2NativeOutputHandler", () => {
  it("routes visible output through processor and scheduler", () => {
    const scheduler = { push: vi.fn(), flush: vi.fn() };
    const processOutput = vi.fn(() => baseResult);
    const handler = createTerminalV2NativeOutputHandler({
      cwd: "/repo",
      processOutput,
      scheduler,
    });

    handler.handleOutput("hello");

    expect(processOutput).toHaveBeenCalledWith(expect.objectContaining({ data: "hello", cwd: "/repo" }));
    expect(scheduler.push).toHaveBeenCalledWith("hello");
    // The scheduler batches per frame; flushing per chunk is the cost this path must not pay.
    expect(scheduler.flush).not.toHaveBeenCalled();
  });

  it("publishes cwd markers parsed from shell integration without rendering them", () => {
    const onCurrentDirectoryChange = vi.fn();
    const scheduler = { push: vi.fn(), flush: vi.fn() };
    const handler = createTerminalV2NativeOutputHandler({
      cwd: "/repo",
      onCurrentDirectoryChange,
      processOutput: vi.fn(() => ({ ...baseResult, visibleData: "", cwdUpdates: ["/repo/packages"] })),
      scheduler,
    });

    handler.handleOutput("\u001b]777;lotus-cwd=/repo/packages\u0007");

    expect(onCurrentDirectoryChange).toHaveBeenCalledWith("/repo/packages");
    expect(scheduler.push).not.toHaveBeenCalled();
  });

  it("parks output in the standby backlog while another renderer owns the pane", () => {
    const scheduler = { push: vi.fn(), flush: vi.fn() };
    const standbyBacklog = { isActive: vi.fn(() => true), append: vi.fn() };
    const noteOutputChunk = vi.fn();
    const handler = createTerminalV2NativeOutputHandler({
      cwd: "/repo",
      noteOutputChunk,
      processOutput: vi.fn(() => baseResult),
      scheduler,
      standbyBacklog,
    });

    handler.handleOutput("hello");

    expect(standbyBacklog.append).toHaveBeenCalledWith("hello");
    expect(scheduler.push).not.toHaveBeenCalled();
    expect(noteOutputChunk).toHaveBeenCalledWith("hello");
  });

  it("resumes writing to its own renderer once the pane is no longer served elsewhere", () => {
    const scheduler = { push: vi.fn(), flush: vi.fn() };
    const standbyBacklog = { isActive: vi.fn(() => false), append: vi.fn() };
    const handler = createTerminalV2NativeOutputHandler({
      cwd: "/repo",
      processOutput: vi.fn(() => baseResult),
      scheduler,
      standbyBacklog,
    });

    handler.handleOutput("hello");

    expect(scheduler.push).toHaveBeenCalledWith("hello");
    expect(standbyBacklog.append).not.toHaveBeenCalled();
  });

  it("still reports session exit while parked in the standby backlog", () => {
    const onExit = vi.fn();
    const setLive = vi.fn();
    const notifyRuntimeStatus = vi.fn();
    const standbyBacklog = { isActive: vi.fn(() => true), append: vi.fn() };
    const handler = createTerminalV2NativeOutputHandler({
      cwd: "/repo",
      notifyRuntimeStatus,
      onExit,
      processOutput: vi.fn(() => ({ ...baseResult, visibleData: "", exitCode: 3 })),
      scheduler: { push: vi.fn(), flush: vi.fn() },
      setLive,
      standbyBacklog,
    });

    handler.handleOutput("raw");

    expect(standbyBacklog.append).toHaveBeenCalledWith("\r\n\u001b[2m[session exited 3]\u001b[0m\r\n");
    expect(setLive).toHaveBeenCalledWith(false);
    expect(notifyRuntimeStatus).toHaveBeenCalledWith("exited");
    expect(onExit).toHaveBeenCalledWith(3);
  });

  it("notifies activity tracking with visible output", () => {
    const noteOutputChunk = vi.fn();
    const scheduler = { push: vi.fn(), flush: vi.fn() };
    const handler = createTerminalV2NativeOutputHandler({
      cwd: "/repo",
      noteOutputChunk,
      processOutput: vi.fn(() => ({ ...baseResult, visibleData: "ready footer" })),
      scheduler,
    });

    handler.handleOutput("raw");

    expect(noteOutputChunk).toHaveBeenCalledWith("ready footer");
    expect(scheduler.push).toHaveBeenCalledWith("ready footer");
  });

  it("writes an exit marker before callbacks when session exit has no visible output", () => {
    const onExit = vi.fn();
    const onRuntimeSessionIdChange = vi.fn();
    const notifyRuntimeStatus = vi.fn();
    const setLive = vi.fn();
    const scheduler = { push: vi.fn(), flush: vi.fn() };
    const handler = createTerminalV2NativeOutputHandler({
      cwd: "/repo",
      notifyRuntimeStatus,
      onExit,
      onRuntimeSessionIdChange,
      processOutput: vi.fn(() => ({ ...baseResult, visibleData: "", exitCode: 9, outputRoute: "none" as const })),
      scheduler,
      setLive,
    });

    handler.handleOutput("[Session ended:9]");

    expect(scheduler.push).toHaveBeenCalledWith("\r\n\u001b[2m[session exited 9]\u001b[0m\r\n");
    expect(scheduler.flush).toHaveBeenCalledBefore(notifyRuntimeStatus);
    expect(setLive).toHaveBeenCalledWith(false);
    expect(onRuntimeSessionIdChange).toHaveBeenCalledWith(null);
    expect(notifyRuntimeStatus).toHaveBeenCalledWith("exited");
    expect(onExit).toHaveBeenCalledWith(9);
  });

  it("preserves visible exit output before marking the native session exited", () => {
    const onExit = vi.fn();
    const onRuntimeSessionIdChange = vi.fn();
    const notifyRuntimeStatus = vi.fn();
    const setLive = vi.fn();
    const scheduler = { push: vi.fn(), flush: vi.fn() };
    const handler = createTerminalV2NativeOutputHandler({
      cwd: "/repo",
      notifyRuntimeStatus,
      onExit,
      onRuntimeSessionIdChange,
      processOutput: vi.fn(() => ({
        ...baseResult,
        visibleData: "\r\nlogout\r\n",
        exitCode: 0,
        outputRoute: "visible" as const,
      })),
      scheduler,
      setLive,
    });

    handler.handleOutput("raw exit chunk");

    expect(scheduler.push).toHaveBeenCalledWith("\r\nlogout\r\n");
    expect(scheduler.flush).toHaveBeenCalledBefore(notifyRuntimeStatus);
    expect(setLive).toHaveBeenCalledWith(false);
    expect(onRuntimeSessionIdChange).toHaveBeenCalledWith(null);
    expect(notifyRuntimeStatus).toHaveBeenCalledWith("exited");
    expect(onExit).toHaveBeenCalledWith(0);
  });
});

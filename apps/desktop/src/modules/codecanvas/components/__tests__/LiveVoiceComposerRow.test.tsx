import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import { LiveVoiceComposerRow } from "../LiveVoiceComposerRow";

describe("LiveVoiceComposerRow", () => {
  it("live phases show → Lotus and a single End that stops the session (not a retry)", () => {
    const onEnd = vi.fn();
    const onRetry = vi.fn();
    render(<LiveVoiceComposerRow phase="listening" agentSpeaking={false} onEnd={onEnd} onRetry={onRetry} />);
    expect(screen.getByTitle("Lotus")).toHaveTextContent("Lotus");
    expect(screen.getByText("Listening…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "End Live Voice" }));
    expect(onEnd).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
    // No retry affordance while healthy.
    expect(screen.queryByRole("button", { name: "Retry Live Voice" })).toBeNull();
  });

  it("keeps routine live health out of the visible row while preserving sanitized diagnostics", () => {
    render(
      <LiveVoiceComposerRow
        phase="agent"
        agentSpeaking
        health={{ socket: "connected", mic: "active", playback: "playing", tools: "ok", audioDeltas: 2, nativeQueueUsed: 4, nativeDroppedAudioChunks: 1, lastTool: "dispatch" }}
        onEnd={() => {}}
      />,
    );

    const healthText = "Socket connected · Mic active · Playback playing · Audio 2 · Queue 4 · Dropped 1 · Tool ok: dispatch";
    expect(screen.queryByText(healthText)).toBeNull();
    expect(screen.getByRole("status")).toHaveAttribute("title", healthText);
    expect(screen.getByRole("status")).toHaveTextContent("Lotus is speaking — talk to interrupt");
  });

  it("shows truthful post-speech progress instead of generic thinking copy", () => {
    const { rerender } = render(
      <LiveVoiceComposerRow
        phase="thinking"
        agentSpeaking={false}
        health={{ socket: "connected", mic: "active", playback: "ready", tools: "idle", audioDeltas: 0 }}
        onEnd={() => {}}
      />,
    );
    expect(screen.getByText("Finishing your turn…")).toBeInTheDocument();

    rerender(
      <LiveVoiceComposerRow
        phase="thinking"
        agentSpeaking={false}
        health={{ socket: "connected", mic: "active", playback: "ready", tools: "running", audioDeltas: 0, lastTool: "dispatch" }}
        onEnd={() => {}}
      />,
    );
    expect(screen.getByText("Preparing handoff…")).toBeInTheDocument();
    expect(screen.queryByText("Thinking…")).toBeNull();
  });

  it("error state is never a dead-end: offers Close (→ default bar) AND Retry, with the details", () => {
    const onEnd = vi.fn();
    const onRetry = vi.fn();
    render(
      <LiveVoiceComposerRow
        phase="error"
        agentSpeaking={false}
        error="The Realtime Beta API is no longer supported."
        health={{ socket: "error", mic: "idle", playback: "error", tools: "idle", audioDeltas: 0, lastIssue: "audio output blocked" }}
        onEnd={onEnd}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText(/no longer supported/i)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute("title", expect.stringContaining("Socket error"));

    fireEvent.click(screen.getByRole("button", { name: "Close Live Voice" }));
    expect(onEnd).toHaveBeenCalledOnce(); // Close returns to default, does NOT retry.

    fireEvent.click(screen.getByRole("button", { name: "Retry Live Voice" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("falls back to the last health issue when the session reports no error text", () => {
    render(
      <LiveVoiceComposerRow
        phase="error"
        agentSpeaking={false}
        health={{ socket: "error", mic: "idle", playback: "idle", tools: "idle", audioDeltas: 0, lastIssue: "audio output blocked" }}
        onEnd={() => {}}
      />,
    );
    expect(screen.getByText("audio output blocked")).toBeInTheDocument();
  });

  it("error state still renders a working Close when no onRetry is provided", () => {
    const onEnd = vi.fn();
    render(<LiveVoiceComposerRow phase="error" agentSpeaking={false} error="boom" onEnd={onEnd} />);
    expect(screen.queryByRole("button", { name: "Retry Live Voice" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close Live Voice" }));
    expect(onEnd).toHaveBeenCalledOnce();
  });
});

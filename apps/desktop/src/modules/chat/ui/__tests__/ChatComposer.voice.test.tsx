import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useSpeechToText = vi.fn();
vi.mock("@/modules/voice-core/use-speech-to-text", () => ({
  useSpeechToText: (...args: unknown[]) => useSpeechToText(...args),
}));
const openSettings = vi.hoisted(() => vi.fn());
vi.mock("@/modules/lotus-settings/lotus-settings-context", () => ({
  useLotusSettings: () => ({ open: false, openSettings, closeSettings: () => {} }),
}));

import { resetVoiceInputStoreForTests, setVoiceInputSetting } from "@/modules/codecanvas/hooks/useVoiceInputSettings";
import { ChatComposer } from "../ChatComposer";

const base = { threadId: "thread-1", details: ["Opus 5.5"], onStop: vi.fn(), waiting: [], cwd: "/w/lotus", onDecide: vi.fn(), unread: [] };
const idle = { mode: "send" as const, activity: null };

function fakeStt({ available = true, transcript = "rename the cookie in the docs" } = {}) {
  const stt = {
    available,
    starting: false,
    recording: false,
    transcribing: false,
    interim: "",
    start: vi.fn(async () => true),
    stop: vi.fn(async () => transcript),
    cancel: vi.fn(),
    getLastTurnMetadata: () => null,
  };
  useSpeechToText.mockReturnValue(stt);
  return stt;
}

async function dictate() {
  fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
  fireEvent.click(await screen.findByRole("button", { name: "Insert dictation" }));
  await screen.findByRole("button", { name: "Dictate" });
}

describe("ChatComposer dictation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem("lotus-voice-input-v1");
    resetVoiceInputStoreForTests();
  });

  it("offers the mic as the main button while the field is empty", () => {
    fakeStt();
    render(<ChatComposer {...base} onSend={vi.fn()} status={idle} />);
    expect(screen.getByRole("button", { name: "Dictate" }).dataset.primary).toBe("true");
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("puts what was said at the caret, unsent", async () => {
    fakeStt();
    const onSend = vi.fn();
    render(<ChatComposer {...base} onSend={onSend} status={idle} fill={{ text: "Yes please,", n: 1 }} />);
    const editor = screen.getByRole("textbox", { name: "Message" });
    await waitFor(() => expect(editor.textContent).toBe("Yes please,"));
    await dictate();
    await waitFor(() => expect(editor.textContent).toBe("Yes please, rename the cookie in the docs"));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false);
  });

  it("sends at once with Send Right Away on", async () => {
    fakeStt();
    setVoiceInputSetting("sendRightAway", true);
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<ChatComposer {...base} onSend={onSend} status={idle} />);
    await dictate();
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Rename the cookie in the docs", []));
  });

  it("says so when nothing was heard, and leaves the box as it was", async () => {
    fakeStt({ transcript: "" });
    const onSend = vi.fn();
    render(<ChatComposer {...base} onSend={onSend} status={idle} />);
    const editor = screen.getByRole("textbox", { name: "Message" });
    await dictate();
    expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringContaining("Didn't catch that"));
    expect(editor.textContent).toBe("");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("opens Voice settings instead of recording when no provider is set", async () => {
    const stt = fakeStt({ available: false });
    render(<ChatComposer {...base} onSend={vi.fn()} status={idle} />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    await waitFor(() => expect(openSettings).toHaveBeenCalledWith({ from: "dictate" }));
    expect(stt.start).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveProperty("textContent", expect.stringContaining("needs a provider"));
  });

  it("hides the mic while a question card owns the answer", () => {
    fakeStt();
    const question = {
      kind: "question" as const,
      id: "q1",
      questions: [{ header: "Pick", question: "Which?", options: [{ label: "A" }], multiSelect: false }],
    };
    render(
      <ChatComposer
        {...base}
        onSend={vi.fn()}
        status={{ mode: "send", activity: "Asking" }}
        waiting={[{ interaction: question, turnId: "t", requestedAt: 0, resolution: null }] as never}
      />,
    );
    expect(screen.queryByRole("button", { name: "Dictate" })).toBeNull();
  });
});

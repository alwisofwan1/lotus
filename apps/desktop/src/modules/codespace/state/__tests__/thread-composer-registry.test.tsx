import React from "react";
import { render, renderHook, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ThreadComposerRegistryProvider,
  useCreateThreadComposerRegistry,
  useThreadComposerRegistry,
  type ThreadPromptHandle,
} from "../thread-composer-registry";

function Conversation({ sessionId, send }: { sessionId: string; send: (text: string) => void }) {
  const registry = useThreadComposerRegistry();
  React.useEffect(() => registry?.register(sessionId, send), [registry, send, sessionId]);
  return null;
}

function Composer({ sessionId }: { sessionId: string }) {
  const registry = useThreadComposerRegistry();
  const [delivered, setDelivered] = React.useState<boolean | null>(null);
  return (
    <>
      <button type="button" onClick={() => setDelivered(registry?.send(sessionId, "halo") ?? false)}>
        send
      </button>
      <span data-testid="delivered">{String(delivered)}</span>
    </>
  );
}

describe("ThreadComposerRegistry", () => {
  it("delivers to the conversation that registered for that session", () => {
    const send = vi.fn();
    render(
      <ThreadComposerRegistryProvider>
        <Conversation sessionId="s1" send={send} />
        <Composer sessionId="s1" />
      </ThreadComposerRegistryProvider>,
    );

    fireEvent.click(screen.getByText("send"));

    expect(send).toHaveBeenCalledWith("halo");
    expect(screen.getByTestId("delivered").textContent).toBe("true");
  });

  it("reports back instead of swallowing the text when nobody is listening", () => {
    render(
      <ThreadComposerRegistryProvider>
        <Composer sessionId="gone" />
      </ThreadComposerRegistryProvider>,
    );

    fireEvent.click(screen.getByText("send"));

    expect(screen.getByTestId("delivered").textContent).toBe("false");
  });

  it("does not let a departing conversation unregister the one that replaced it", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      <ThreadComposerRegistryProvider>
        <Conversation key="a" sessionId="s1" send={first} />
        <Composer sessionId="s1" />
      </ThreadComposerRegistryProvider>,
    );

    // A remount: React mounts the replacement before cleaning up the one it replaces.
    rerender(
      <ThreadComposerRegistryProvider>
        <Conversation key="a" sessionId="s1" send={second} />
        <Composer sessionId="s1" />
      </ThreadComposerRegistryProvider>,
    );

    fireEvent.click(screen.getByText("send"));

    expect(second).toHaveBeenCalledWith("halo");
    expect(first).not.toHaveBeenCalled();
  });
});

describe("ThreadComposerRegistry — a thread's own input (Held Prompt)", () => {
  function setup() {
    const { result } = renderHook(() => useCreateThreadComposerRegistry());
    const handle = { insert: vi.fn(), submit: vi.fn<(extra?: string) => boolean>(() => true), remove: vi.fn() } satisfies ThreadPromptHandle;
    return { registry: result.current, handle };
  }

  it("puts text in the input of the thread that registered one, unsent", () => {
    const { registry, handle } = setup();
    registry.registerPrompt("s1", handle);
    expect(registry.insert("s1", "fix the test")).toBe(true);
    expect(handle.insert).toHaveBeenCalledWith("fix the test");
  });

  it("says a thread with no registered input cannot take unsent text", () => {
    const { registry } = setup();
    registry.register("s1", vi.fn());
    expect(registry.insert("s1", "fix the test")).toBe(false);
    expect(registry.submit("s1")).toBe("gone");
    expect(registry.remove("s1", "fix the test")).toBe(false);
  });

  it("sends and clears through the thread's input", () => {
    const { registry, handle } = setup();
    registry.registerPrompt("s1", handle);
    expect(registry.submit("s1", "and the lint")).toBe("sent");
    expect(registry.remove("s1", "fix the test")).toBe(true);
    expect(handle.submit).toHaveBeenCalledWith("and the lint");
    expect(handle.remove).toHaveBeenCalledWith("fix the test");
  });

  it("reports a thread that could not send its input", () => {
    const { registry, handle } = setup();
    handle.submit.mockReturnValue(false);
    registry.registerPrompt("s1", handle);
    expect(registry.submit("s1")).toBe("answering");
  });

  it("tells listeners when a thread's input was emptied, by whoever", () => {
    const { registry } = setup();
    const listener = vi.fn();
    const off = registry.onPromptEmptied(listener);
    registry.promptEmptied("s1");
    off();
    registry.promptEmptied("s1");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("s1");
  });

  it("does not let a departing input unregister the one that replaced it", () => {
    const { registry, handle } = setup();
    const replacement = { insert: vi.fn(), submit: vi.fn(() => true), remove: vi.fn() };
    const offFirst = registry.registerPrompt("s1", handle);
    registry.registerPrompt("s1", replacement);
    offFirst();
    registry.insert("s1", "x");
    expect(replacement.insert).toHaveBeenCalledWith("x");
  });
});

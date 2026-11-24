import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { GridCell } from "@/modules/codespace/components/types";
import type { ThreadComposerRegistry } from "@/modules/codespace/state/thread-composer-registry";
import type { ComposerRoute } from "../../services/composer-routing";
import { heldPromptAnsweringReason, useHeldPrompt } from "../useHeldPrompt";

const CHAT = { id: "p2", type: "chat", sessionId: "chat-1" } as GridCell;
const THREAD: Extract<ComposerRoute, { kind: "thread" }> = { kind: "thread", paneId: "p2", sessionId: "chat-1" };
const NOTES = { id: "p2", name: "Release notes" };

/** A thread's input, as the registry reaches it: what is in it, and whether it is still answering. */
function fakeThread() {
  const input = { value: "", answering: false, registered: true, sent: [] as string[] };
  const emptied = new Set<(sessionId: string) => void>();
  const empty = () => {
    input.value = "";
    emptied.forEach((listener) => listener("chat-1"));
  };
  const registry = {
    insert: (_sessionId: string, text: string) => {
      if (!input.registered) return false;
      input.value = input.value ? `${input.value} ${text}` : text;
      return true;
    },
    submit: (_sessionId: string, extra?: string) => {
      if (!input.registered) return "gone";
      const message = [input.value, extra].filter(Boolean).join(" ");
      if (input.answering || !message) return "answering";
      input.sent.push(message);
      empty();
      return "sent";
    },
    remove: (_sessionId: string, text: string) => {
      if (input.value.endsWith(text)) input.value = input.value.slice(0, -text.length).trim();
      if (!input.value) empty();
      return true;
    },
    onPromptEmptied: (listener: (sessionId: string) => void) => {
      emptied.add(listener);
      return () => emptied.delete(listener);
    },
  } as unknown as ThreadComposerRegistry;
  return { input, registry, empty };
}

function renderHeld(thread = fakeThread(), cells: GridCell[] = [CHAT]) {
  const hook = renderHook(({ cells: current }) => useHeldPrompt({ cells: current, threadComposers: thread.registry }), {
    initialProps: { cells },
  });
  return { ...hook, thread };
}

describe("useHeldPrompt — a thread", () => {
  it("puts a spoken turn in the thread's input, unsent", async () => {
    const { result, thread } = renderHeld();
    await act(async () => {
      expect(await result.current.place("summarise this", THREAD, NOTES)).toEqual({ ok: true });
    });
    expect(thread.input.value).toBe("summarise this");
    expect(thread.input.sent).toEqual([]);
    expect(result.current.held).toMatchObject({ paneId: "p2", name: "Release notes", text: "summarise this" });
  });

  it("refuses when the thread has no input open", async () => {
    const thread = fakeThread();
    thread.input.registered = false;
    const { result } = renderHeld(thread);
    let outcome;
    await act(async () => {
      outcome = await result.current.place("summarise this", THREAD, NOTES);
    });
    expect(outcome).toMatchObject({ ok: false });
    expect(result.current.held).toBeNull();
  });

  it("sends it on Enter", async () => {
    const { result, thread } = renderHeld();
    await act(async () => void (await result.current.place("summarise this", THREAD, NOTES)));
    await act(async () => void (await result.current.send()));
    expect(thread.input.sent).toEqual(["summarise this"]);
    expect(result.current.held).toBeNull();
  });

  it("keeps it while the thread is still answering, and says why", async () => {
    const { result, thread } = renderHeld();
    await act(async () => void (await result.current.place("summarise this", THREAD, NOTES)));
    thread.input.answering = true;
    let outcome;
    await act(async () => {
      outcome = await result.current.send();
    });
    expect(outcome).toEqual({ ok: false, reason: heldPromptAnsweringReason("Release notes") });
    expect(thread.input.sent).toEqual([]);
    expect(result.current.held).not.toBeNull();
  });

  it("takes only the spoken text back out of the thread's input on Escape", async () => {
    const thread = fakeThread();
    thread.input.value = "draft";
    const { result } = renderHeld(thread);
    await act(async () => void (await result.current.place("summarise this", THREAD, NOTES)));
    await act(async () => void (await result.current.clear()));
    expect(thread.input.value).toBe("draft");
    expect(result.current.held).toBeNull();
  });

  it("is forgotten, and says so, when the thread's input is no longer there on Enter", async () => {
    const { result, thread } = renderHeld();
    await act(async () => void (await result.current.place("summarise this", THREAD, NOTES)));
    thread.input.registered = false;
    let outcome;
    await act(async () => {
      outcome = await result.current.send();
    });
    expect(outcome).toMatchObject({ ok: false });
    expect(result.current.held).toBeNull();
  });

  it("keeps a typed message with it in the thread while the thread is still answering", async () => {
    const { result, thread } = renderHeld();
    await act(async () => void (await result.current.place("summarise this", THREAD, NOTES)));
    thread.input.answering = true;
    let outcome;
    await act(async () => {
      outcome = await result.current.sendJoined("in three bullets");
    });
    expect(outcome).toEqual({ ok: false, reason: heldPromptAnsweringReason("Release notes") });
    expect(thread.input.value).toBe("summarise this in three bullets");
    expect(result.current.held?.text).toBe("summarise this in three bullets");
    thread.input.answering = false;
    await act(async () => void (await result.current.send()));
    expect(thread.input.sent).toEqual(["summarise this in three bullets"]);
  });

  it("is forgotten when the thread's input is sent or emptied there", async () => {
    const { result, thread } = renderHeld();
    await act(async () => void (await result.current.place("summarise this", THREAD, NOTES)));
    act(() => thread.empty());
    expect(result.current.held).toBeNull();
  });

  it("sends a typed message after it, as one", async () => {
    const { result, thread } = renderHeld();
    await act(async () => void (await result.current.place("summarise this", THREAD, NOTES)));
    expect(result.current.joins(THREAD)).toBe(true);
    await act(async () => void (await result.current.sendJoined("in three bullets")));
    expect(thread.input.sent).toEqual(["summarise this in three bullets"]);
    expect(result.current.held).toBeNull();
  });

  it("is forgotten when its pane closes", async () => {
    const { result, rerender } = renderHeld();
    await act(async () => void (await result.current.place("summarise this", THREAD, NOTES)));
    rerender({ cells: [] });
    expect(result.current.held).toBeNull();
  });
});

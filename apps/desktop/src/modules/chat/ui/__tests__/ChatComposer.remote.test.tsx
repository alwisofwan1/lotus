import React from "react";
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatComposer } from "../ChatComposer";
import { CHAT_FILE_DROP, CHAT_FILE_OVER } from "../file-drag";

const base = { threadId: "thread-1", details: [], onSend: vi.fn(), onStop: vi.fn(), waiting: [], cwd: "/srv/app", onDecide: vi.fn(), status: { mode: "send" as const, activity: null }, unread: [] };
const onMachine = { kind: "file" as const, path: "/srv/app/env.ts", name: "env.ts", mimeType: null, sizeBytes: null, remote: "/srv/app/env.ts" };

describe("ChatComposer on another machine", () => {
  it("takes a file dragged from the Files tab, by its path there, with no copy", async () => {
    const { container } = render(<ChatComposer {...base} remote />);
    const form = container.querySelector("[data-chat-file-drop]")!;
    act(() => void form.dispatchEvent(new CustomEvent(CHAT_FILE_OVER, { detail: true })));
    expect(screen.getByText("Drop to attach")).toBeTruthy();
    act(() => {
      form.dispatchEvent(new CustomEvent(CHAT_FILE_OVER, { detail: false }));
      form.dispatchEvent(new CustomEvent(CHAT_FILE_DROP, { detail: onMachine }));
    });
    expect(await screen.findByText("On the machine")).toBeTruthy();
    expect(screen.queryByText("Drop to attach")).toBeNull();
  });

  it("is no drop target for a chat on this Mac", () => {
    const { container } = render(<ChatComposer {...base} />);
    expect(container.querySelector("[data-chat-file-drop]")).toBeNull();
  });
});

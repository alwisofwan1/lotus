import { afterEach, describe, expect, it, vi } from "vitest";

import type { Attachment } from "../../domain/thread-event";
import { beginFileDrag, CHAT_FILE_DROP, CHAT_FILE_OVER } from "../file-drag";

const file: Attachment = { kind: "file", path: "/srv/app/a.ts", name: "a.ts", mimeType: null, sizeBytes: null, remote: "/srv/app/a.ts" };

function scene() {
  const row = document.createElement("button");
  const card = document.createElement("div");
  card.setAttribute("data-chat-file-drop", "");
  document.body.append(row, card);
  return { row, card };
}

const pointer = (type: string, x: number, y: number) => window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y }));

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("beginFileDrag", () => {
  it("hands the file to the composer it is dropped on, and lights it on the way", () => {
    const { row, card } = scene();
    const over: boolean[] = [];
    const dropped: Attachment[] = [];
    card.addEventListener(CHAT_FILE_OVER, (e) => over.push((e as CustomEvent<boolean>).detail));
    card.addEventListener(CHAT_FILE_DROP, (e) => dropped.push((e as CustomEvent<Attachment>).detail));
    document.elementFromPoint = () => card;

    beginFileDrag({ button: 0, clientX: 0, clientY: 0, currentTarget: row }, file);
    pointer("pointermove", 40, 40);
    pointer("pointerup", 40, 40);

    expect(over).toEqual([true, false]);
    expect(dropped).toEqual([file]);
    expect(document.querySelector(".chat-file-drag-chip")).toBeNull();
  });

  it("is a click, not a drag, when the pointer barely moves; and drops nothing off a composer", () => {
    const { row, card } = scene();
    const dropped = vi.fn();
    card.addEventListener(CHAT_FILE_DROP, dropped);
    document.elementFromPoint = () => document.body;

    beginFileDrag({ button: 0, clientX: 0, clientY: 0, currentTarget: row }, file);
    pointer("pointermove", 2, 1);
    expect(document.querySelector(".chat-file-drag-chip")).toBeNull();
    pointer("pointermove", 50, 50);
    pointer("pointerup", 50, 50);
    expect(dropped).not.toHaveBeenCalled();
  });
});

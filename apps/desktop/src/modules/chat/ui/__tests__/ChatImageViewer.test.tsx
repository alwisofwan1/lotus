import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Attachment } from "../../domain/thread-event";
import { AttachmentDrafts, ImageGallery } from "../ChatAttachments";
import { cachedPreview, PREVIEW_CACHE_SIZE, previewCacheKeys } from "../attachment-preview";

vi.mock("../../runtime/chat-runtime-client", () => ({
  attachmentPreview: async (path: string) => {
    if (path.includes("gone")) throw new Error("no longer there");
    return `data:image/png;base64,${path}`;
  },
  readChatFileBytes: () => new Promise(() => {}),
  revealChatFile: vi.fn(async () => {}),
}));

const image = (name: string): Attachment => ({ kind: "image", path: `/shots/${name}`, name, mimeType: "image/png", sizeBytes: 2048 });

describe("ImageGallery", () => {
  it("shows four frames, the last saying how many more", () => {
    render(<ImageGallery images={["a", "b", "c", "d", "e", "f"].map((n) => image(`${n}.png`))} />);
    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Open d.png and 2 more" }).textContent).toBe("+2");
  });

  it("opens on the clicked image, walks all of them with the arrows, and Esc gives focus back", async () => {
    render(<ImageGallery images={["a", "b", "c", "d", "e", "f"].map((n) => image(`${n}.png`))} />);
    const frame = screen.getByRole("button", { name: "Open b.png" });
    frame.focus();
    fireEvent.click(frame);
    const dialog = screen.getByRole("dialog", { name: "b.png, 2 of 6" });
    expect((await within(dialog).findByRole("img", { name: "b.png" })).getAttribute("src")).toBe("data:image/png;base64,/shots/b.png");

    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("f.png, 6 of 6");
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(await within(dialog).findByRole("img", { name: "a.png" })).toBeTruthy();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(frame);
  });
});

describe("ChatImageViewer keys", () => {
  it("keeps Tab inside the dialog", () => {
    render(<ImageGallery images={[image("a.png"), image("b.png")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Open a.png" }));
    expect(document.activeElement).toBe(screen.getByRole("dialog"));

    const strip = screen.getByRole("button", { name: "b.png" });
    strip.focus();
    fireEvent.keyDown(strip, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(strip);
  });

  it("says so when the file can no longer be read", async () => {
    render(<ImageGallery images={[image("gone.png")]} />);
    fireEvent.click(screen.getByRole("button", { name: "Open gone.png" }));
    expect(await screen.findByText("It is no longer on disk, or cannot be read.")).toBeTruthy();
  });
});

describe("AttachmentDrafts", () => {
  it("opens an image from its chip; × removes it without opening", () => {
    const onRemove = vi.fn();
    const drafts = [image("a.png"), image("b.png")].map((attachment) => ({ id: attachment.path, attachment, problem: null }));
    render(<AttachmentDrafts drafts={drafts} onRemove={onRemove} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove a.png" }));
    expect(onRemove).toHaveBeenCalledWith("/shots/a.png");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open b.png" }));
    expect(screen.getByRole("dialog", { name: "b.png, 2 of 2" })).toBeTruthy();
  });
});

describe("preview cache", () => {
  it("keeps the most recently used PREVIEW_CACHE_SIZE paths", async () => {
    const load = async (path: string) => path;
    for (let i = 0; i < PREVIEW_CACHE_SIZE; i++) await cachedPreview(`/p/${i}`, load);
    await cachedPreview("/p/0", load); // used again: now the newest
    await cachedPreview("/p/new", load);
    const keys = previewCacheKeys();
    expect(keys).toHaveLength(PREVIEW_CACHE_SIZE);
    expect(keys).toContain("/p/0");
    expect(keys).not.toContain("/p/1");
  });
});

import { describe, expect, it, vi } from "vitest";
import { acceptIntake, applyIntakeOutcome, formatPathsForPrompt, resolveImageDropRoute, resolveIntakeFallback, routeIntake, type IntakeExecutorContext } from "../canvas-node-intake";
import type { CanvasImageRef, CanvasIntakePayload } from "../canvas-intake";
import type { DraggedSkill } from "../../hooks/useCanvasSkillDnd";

function spyContext(): IntakeExecutorContext & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {};
  const rec = (name: string) => vi.fn((...args: unknown[]) => { calls[name] = args; });
  return {
    calls,
    appendNoteText: rec("appendNoteText"),
    appendNoteImages: vi.fn((nodeId: string, images: CanvasImageRef[]) => { calls.appendNoteImages = [nodeId, images]; return images.length; }),
    writePty: rec("writePty"),
    applySkill: rec("applySkill"),
    addAttachment: rec("addAttachment"),
    notify: rec("notify"),
  };
}

const skill: DraggedSkill = { name: "review", source: "project", content: "# review" };
const text: CanvasIntakePayload = { kind: "text", text: "hello" };
const url: CanvasIntakePayload = { kind: "url", url: "https://x.dev" };
const filePayload: CanvasIntakePayload = { kind: "file", paths: ["/a/b.csv"] };
const imagePath: CanvasIntakePayload = { kind: "image", images: [{ kind: "path", path: "/a/p.png" }] };
const imageBytes: CanvasIntakePayload = { kind: "image", images: [{ kind: "bytes", name: "p.png", mime: "image/png", base64: "AA" }] };

describe("acceptIntake — note", () => {
  it("appends text and url, embeds images as durable Note content, rejects skills", () => {
    expect(acceptIntake("note", text)).toEqual({ kind: "append-text", text: "hello" });
    expect(acceptIntake("note", url)).toEqual({ kind: "append-text", text: "https://x.dev" });
    expect(acceptIntake("note", imagePath)).toEqual({ kind: "append-note-images", images: imagePath.kind === "image" ? imagePath.images : [] });
    expect(acceptIntake("note", { kind: "skill", skill }).kind).toBe("reject");
  });
});

describe("acceptIntake — terminal", () => {
  it("writes text/url/file-paths to the PTY", () => {
    expect(acceptIntake("terminal", text)).toEqual({ kind: "write-pty", text: "hello" });
    expect(acceptIntake("terminal", url)).toEqual({ kind: "write-pty", text: "https://x.dev" });
    expect(acceptIntake("terminal", filePayload)).toEqual({ kind: "write-pty", text: '"/a/b.csv"' });
  });

  it("writes an image path to the PTY (quoted) but rejects pasted image bytes", () => {
    expect(acceptIntake("terminal", imagePath)).toEqual({ kind: "write-pty", text: '"/a/p.png"' });
    expect(acceptIntake("terminal", imageBytes).kind).toBe("reject");
  });

  it("applies a dropped skill (Canvas Skill Prompt Append)", () => {
    expect(acceptIntake("terminal", { kind: "skill", skill })).toEqual({ kind: "apply-skill", skill });
  });
});

describe("acceptIntake — agent", () => {
  it("attaches images, applies skills, rejects loose text", () => {
    expect(acceptIntake("agent", imagePath)).toEqual({ kind: "add-attachment", images: imagePath.kind === "image" ? imagePath.images : [] });
    expect(acceptIntake("agent", imageBytes).kind).toBe("add-attachment");
    expect(acceptIntake("agent", { kind: "skill", skill })).toEqual({ kind: "apply-skill", skill });
    expect(acceptIntake("agent", text).kind).toBe("reject");
  });
});

describe("acceptIntake — read-only kinds", () => {
  it("rejects everything on skills/skill/plan nodes", () => {
    for (const kind of ["skills", "skill", "plan"] as const) {
      expect(acceptIntake(kind, text).kind).toBe("reject");
      expect(acceptIntake(kind, imagePath).kind).toBe("reject");
    }
  });

  it("a reject always carries a non-empty reason", () => {
    const outcome = acceptIntake("note", { kind: "none" });
    expect(outcome.kind).toBe("reject");
    expect(outcome.kind === "reject" && outcome.reason.length).toBeGreaterThan(0);
  });
});

describe("applyIntakeOutcome", () => {
  it("routes each outcome to the matching executor callback", async () => {
    const ctx = spyContext();
    await applyIntakeOutcome("n1", { kind: "append-text", text: "t" }, ctx);
    await applyIntakeOutcome("n2", { kind: "write-pty", text: "p" }, ctx);
    await applyIntakeOutcome("n3", { kind: "apply-skill", skill }, ctx);
    await applyIntakeOutcome("n4", { kind: "add-attachment", images: [] }, ctx);
    await applyIntakeOutcome("n5", { kind: "reject", reason: "nope" }, ctx);
    expect(ctx.calls.appendNoteText).toEqual(["n1", "t"]);
    expect(ctx.calls.writePty).toEqual(["n2", "p"]);
    expect(ctx.calls.applySkill).toEqual(["n3", skill]);
    expect(ctx.calls.addAttachment).toEqual(["n4", []]);
    expect(ctx.calls.notify).toEqual(["nope"]);
  });

  it("notifies after note images are embedded", async () => {
    const ctx = spyContext();
    await applyIntakeOutcome("n1", { kind: "append-note-images", images: [{ kind: "path", path: "/a/p.png" }] }, ctx);
    expect(ctx.calls.appendNoteImages).toEqual(["n1", [{ kind: "path", path: "/a/p.png" }]]);
    expect(ctx.calls.notify).toEqual(["Embedded 1 image in the Note. Image assets are available to connected agents."]);
  });
});

describe("resolveIntakeFallback — no node target under the drop/paste", () => {
  it("routes an image payload to a standalone canvas image shape", () => {
    expect(resolveIntakeFallback(imageBytes)).toEqual({ kind: "image-shape", images: imageBytes.kind === "image" ? imageBytes.images : [] });
    expect(resolveIntakeFallback(imagePath)).toEqual({ kind: "image-shape", images: imagePath.kind === "image" ? imagePath.images : [] });
  });

  it("routes text/url/file payloads to a new Note target (unchanged behavior)", () => {
    expect(resolveIntakeFallback(text)).toEqual({ kind: "note-target" });
    expect(resolveIntakeFallback(url)).toEqual({ kind: "note-target" });
    expect(resolveIntakeFallback(filePayload)).toEqual({ kind: "note-target" });
  });

  it("declines skill and empty payloads (nothing to place on empty canvas)", () => {
    expect(resolveIntakeFallback({ kind: "skill", skill })).toEqual({ kind: "none" });
    expect(resolveIntakeFallback({ kind: "none" })).toEqual({ kind: "none" });
  });
});

describe("formatPathsForPrompt — quoting so paths with spaces reach the agent intact", () => {
  it("double-quotes each path (a space in ~/Library/Application Support/ must not split)", () => {
    expect(formatPathsForPrompt(["/Users/a/Library/Application Support/x.png"]))
      .toBe('"/Users/a/Library/Application Support/x.png"');
  });

  it("quotes and space-joins multiple paths", () => {
    expect(formatPathsForPrompt(["/a/one.png", "/b/two.png"])).toBe('"/a/one.png" "/b/two.png"');
  });

  it("escapes an embedded double-quote / backslash so the quoting can't be broken out of", () => {
    expect(formatPathsForPrompt(['/a/we"ird.png'])).toBe('"/a/we\\"ird.png"');
    expect(formatPathsForPrompt(["/a/back\\slash.png"])).toBe('"/a/back\\\\slash.png"');
  });

  it("returns empty string for no paths", () => {
    expect(formatPathsForPrompt([])).toBe("");
  });
});

describe("resolveImageDropRoute — where a dropped image goes based on the node under it", () => {
  it("delivers image FILE PATHS to a terminal or live-agent under the drop (into the PTY)", () => {
    expect(resolveImageDropRoute(imagePath, { kind: "terminal" })).toBe("node");
    expect(resolveImageDropRoute(imagePath, { kind: "agent" })).toBe("node");
  });

  it("becomes a shape when the image is dropped on empty canvas or a non-PTY node", () => {
    expect(resolveImageDropRoute(imagePath, null)).toBe("shape");
    expect(resolveImageDropRoute(imagePath, { kind: "note" })).toBe("shape");
    expect(resolveImageDropRoute(imagePath, { kind: "plan" })).toBe("shape");
  });

  it("becomes a shape for pasted BYTES even over a terminal (no path to type into the PTY)", () => {
    expect(resolveImageDropRoute(imageBytes, { kind: "terminal" })).toBe("shape");
    expect(resolveImageDropRoute(imageBytes, { kind: "agent" })).toBe("shape");
  });

  it("is 'shape' for a mixed payload where not every ref is a path", () => {
    const mixed: CanvasIntakePayload = { kind: "image", images: [{ kind: "path", path: "/a.png" }, { kind: "bytes", name: "b", mime: "image/png", base64: "AA" }] };
    expect(resolveImageDropRoute(mixed, { kind: "terminal" })).toBe("shape");
  });
});

describe("routeIntake", () => {
  it("classifies for the node kind then applies the outcome in one call", async () => {
    const ctx = spyContext();
    const outcome = await routeIntake("terminal", "t1", text, ctx);
    expect(outcome).toEqual({ kind: "write-pty", text: "hello" });
    expect(ctx.calls.writePty).toEqual(["t1", "hello"]);
  });
});

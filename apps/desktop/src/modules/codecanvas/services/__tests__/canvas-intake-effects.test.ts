import { describe, expect, it, vi } from "vitest";
import { buildCanvasIntakeEffects, formatSkillPromptAppend, formatSkillForRunner, appendMarkdownBlock, type CanvasIntakeNodeView } from "../canvas-intake-effects";
import { canvasImagesToNoteAssetMarkdown } from "../note-assets";

vi.mock("../note-assets", () => ({
  canvasImagesToNoteAssetMarkdown: vi.fn(async () => "![shot](lotus-note-asset://asset_1)"),
}));

function deps(nodes: Record<string, CanvasIntakeNodeView>, paneInputs: Record<string, string> = {}) {
  const setNoteContent = vi.fn();
  const writeToPane = vi.fn((paneId: string, text: string) => {
    paneInputs[paneId] = `${paneInputs[paneId] ?? ""}${text}`;
  });
  const markApplied = vi.fn();
  const insertIntoAgent = vi.fn();
  const collectAttachment = vi.fn();
  const effects = buildCanvasIntakeEffects({
    getNode: (id) => nodes[id] ?? null,
    setNoteContent,
    writeToPane,
    getPaneInput: (paneId) => paneInputs[paneId] ?? "",
    markApplied,
    insertIntoAgent,
    collectAttachment,
    projectId: "cp_1",
  });
  return { effects, setNoteContent, writeToPane, markApplied, insertIntoAgent, collectAttachment };
}

describe("formatSkillPromptAppend", () => {
  it("adds exactly the needed prompt spacing around a dragged skill", () => {
    expect(formatSkillPromptAppend("review", "")).toBe("/review ");
    expect(formatSkillPromptAppend("review", "build UI")).toBe(" /review ");
    expect(formatSkillPromptAppend("review", "build UI ")).toBe("/review ");
    expect(formatSkillPromptAppend("/review", "/")).toBe("review ");
    expect(formatSkillPromptAppend("review", "please use /")).toBe("review ");
    expect(formatSkillPromptAppend("review", "inspect src/")).toBe(" /review ");
    expect(formatSkillPromptAppend("  review  ", "")).toBe("/review ");
    expect(formatSkillPromptAppend("   ", "build UI")).toBe("");
  });
});

describe("formatSkillForRunner", () => {
  const skill = { name: "review", path: "/Users/a/.claude/skills/review/SKILL.md" };
  it("Claude family → native /skill (insert, trailing space)", () => {
    expect(formatSkillForRunner("claude", skill)).toBe("/review ");
    expect(formatSkillForRunner("ccs", skill)).toBe("/review ");
    expect(formatSkillForRunner("csp", skill)).toBe("/review ");
    expect(formatSkillForRunner(undefined, skill)).toBe("/review "); // unknown runner → claude default
  });
  it("codex → its own $skill command", () => {
    expect(formatSkillForRunner("codex", skill)).toBe("$review ");
  });
  it("a runner with no skill command → reference the skill's actual path (project/global both resolve)", () => {
    expect(formatSkillForRunner("cursor", skill)).toBe(`Read and apply the skill at ${skill.path} `);
    expect(formatSkillForRunner("custom", skill)).toBe(`Read and apply the skill at ${skill.path} `);
  });
  it("falls back to /skill when a path-referencing runner has no path, and blanks an empty name", () => {
    expect(formatSkillForRunner("cursor", { name: "review" })).toBe("/review ");
    expect(formatSkillForRunner("cursor", { name: "  " })).toBe("");
  });
});

describe("appendMarkdownBlock", () => {
  it("separates appended Markdown blocks without accumulating trailing whitespace", () => {
    expect(appendMarkdownBlock("", "![shot](x)")).toBe("![shot](x)");
    expect(appendMarkdownBlock("first\n", "![shot](x)\n")).toBe("first\n\n![shot](x)");
  });
});

describe("buildCanvasIntakeEffects", () => {
  it("appends to existing note content with a newline, or sets it when empty", () => {
    const a = deps({ n1: { content: "first" }, n2: {} });
    a.effects.appendNoteText("n1", "second");
    a.effects.appendNoteText("n2", "only");
    expect(a.setNoteContent).toHaveBeenNthCalledWith(1, "n1", "first\nsecond");
    expect(a.setNoteContent).toHaveBeenNthCalledWith(2, "n2", "only");
  });

  it("writes to the node's runtime pane id, falling back to the node id", () => {
    const a = deps({ t1: { runtimePaneId: "pane-9" }, t2: {} });
    a.effects.writePty("t1", "ls");
    a.effects.writePty("t2", "pwd");
    expect(a.writeToPane).toHaveBeenNthCalledWith(1, "pane-9", "ls");
    expect(a.writeToPane).toHaveBeenNthCalledWith(2, "t2", "pwd");
  });

  it("applies a skill to a terminal by writing /skill AND marking it applied", () => {
    const a = deps({ t1: { type: "terminal", runtimePaneId: "pane-1" } });
    a.effects.applySkill("t1", { name: "review", source: "project", content: "" });
    expect(a.writeToPane).toHaveBeenCalledWith("pane-1", "/review ");
    expect(a.markApplied).toHaveBeenCalledWith("t1", "review");
  });

  it("prefixes a skill with one space when the terminal already has prompt content", () => {
    const a = deps({ t1: { type: "terminal", runtimePaneId: "pane-1" } }, { "pane-1": "build UI" });
    a.effects.applySkill("t1", { name: "review", source: "project", content: "" });
    expect(a.writeToPane).toHaveBeenCalledWith("pane-1", " /review ");
  });

  it("does not double the slash when the current prompt already ends with slash", () => {
    const a = deps({ t1: { type: "terminal", runtimePaneId: "pane-1" } }, { "pane-1": "use /" });
    a.effects.applySkill("t1", { name: "review", source: "project", content: "" });
    expect(a.writeToPane).toHaveBeenCalledWith("pane-1", "review ");
  });

  it("applies a skill to a headless agent by marking only — no PTY write, no insert", () => {
    const a = deps({ a1: { type: "agent" } });
    a.effects.applySkill("a1", { name: "review", source: "project", content: "" });
    expect(a.writeToPane).not.toHaveBeenCalled();
    expect(a.insertIntoAgent).not.toHaveBeenCalled();
    expect(a.markApplied).toHaveBeenCalledWith("a1", "review");
  });

  it("INSERTS /skill into a LIVE Claude agent (no submit) and marks it applied (ADR-0027 Phase 6a)", () => {
    const a = deps({ a1: { type: "agent", executionMode: "live", runner: "claude" } });
    a.effects.applySkill("a1", { name: "review", source: "project", content: "" });
    // Inserted, not submitted; no terminal-pane write.
    expect(a.writeToPane).not.toHaveBeenCalled();
    expect(a.insertIntoAgent).toHaveBeenCalledWith("a1", "/review ");
    expect(a.markApplied).toHaveBeenCalledWith("a1", "review");
  });

  it("INSERTS Codex's own $skill command into a LIVE codex agent — ADR-0027 Phase 6a", () => {
    const a = deps({ a1: { type: "agent", executionMode: "live", runner: "codex" } });
    a.effects.applySkill("a1", { name: "review", source: "global", content: "", path: "/g/skills/review/SKILL.md" });
    expect(a.insertIntoAgent).toHaveBeenCalledWith("a1", "$review ");
    expect(a.markApplied).toHaveBeenCalledWith("a1", "review");
  });

  it("INSERTS a path reference into a LIVE agent whose runner has no skill command", () => {
    const a = deps({ a1: { type: "agent", executionMode: "live", runner: "cursor" } });
    a.effects.applySkill("a1", { name: "review", source: "global", content: "", path: "/g/skills/review/SKILL.md" });
    expect(a.insertIntoAgent).toHaveBeenCalledWith("a1", "Read and apply the skill at /g/skills/review/SKILL.md ");
  });

  it("embeds dropped Note images as durable Markdown appended to current content", async () => {
    const a = deps({ n1: { content: "spec" } });
    const images = [{ kind: "path" as const, path: "/tmp/shot.png" }];
    await expect(a.effects.appendNoteImages("n1", images)).resolves.toBe(1);
    expect(canvasImagesToNoteAssetMarkdown).toHaveBeenCalledWith("cp_1", images);
    expect(a.setNoteContent).toHaveBeenCalledWith("n1", "spec\n\n![shot](lotus-note-asset://asset_1)");
  });

  it("forwards attachments to the collector for a headless agent (run_codechat consumes them)", () => {
    const a = deps({ x: { type: "agent", executionMode: "headless" } });
    const images = [{ kind: "path" as const, path: "/a.png" }];
    a.effects.addAttachment("x", images);
    expect(a.collectAttachment).toHaveBeenCalledWith("x", images);
    expect(a.insertIntoAgent).not.toHaveBeenCalled();
  });

  it("types the file path into a LIVE agent's prompt (the attachment store is a dead end for live PTY agents)", () => {
    const a = deps({ x: { type: "agent", executionMode: "live" } });
    a.effects.addAttachment("x", [
      { kind: "path", path: "/Users/a/shot.png" },
      { kind: "path", path: "/Users/a/two.png" },
    ]);
    // Paths inserted quoted (no submit) so Claude Code attaches them — spaces would otherwise split.
    expect(a.insertIntoAgent).toHaveBeenCalledWith("x", '"/Users/a/shot.png" "/Users/a/two.png" ');
    expect(a.collectAttachment).not.toHaveBeenCalled();
  });

  it("falls back to the collector when a live agent gets pasted bytes (no path to type)", () => {
    const a = deps({ x: { type: "agent", executionMode: "live" } });
    const images = [{ kind: "bytes" as const, name: "p.png", mime: "image/png", base64: "AA" }];
    a.effects.addAttachment("x", images);
    expect(a.insertIntoAgent).not.toHaveBeenCalled();
    expect(a.collectAttachment).toHaveBeenCalledWith("x", images);
  });
});

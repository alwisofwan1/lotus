import { describe, expect, it } from "vitest";
import { autoBump, classify, draftText, nextVersion, parseNotes, TODO_TITLE } from "../release-notes.mjs";

const c = (subject, body = "") => ({ subject, body });

describe("classify", () => {
  it("keeps app-facing commits and sorts them into sections", () => {
    const r = classify([
      c("feat(chat): attach images and files to a message (#279)"),
      c("fix(settings): Update all drew white text on white"),
      c("perf: faster canvas pan"),
      c("refactor(pty): split the reader"),
      c("feat(web): redesign the site"),
      c("fix(pocket): scroll jump"),
      c("chore(release): Lotus 0.2.3"),
      c("docs: readme"),
    ]);
    expect(r).toEqual({
      added: ["Attach images and files to a message"],
      improved: ["Faster canvas pan"],
      fixed: ["Update all drew white text on white"],
      bump: "minor",
    });
  });

  it("bumps: fix/perf/refactor patch, feat minor, breaking major", () => {
    expect(classify([c("refactor: x")]).bump).toBe("patch");
    expect(classify([c("fix: x"), c("perf: y")]).bump).toBe("patch");
    expect(classify([c("fix: x"), c("feat: y")]).bump).toBe("minor");
    expect(classify([c("feat!: drop the old config")]).bump).toBe("major");
    expect(classify([c("fix: x", "BREAKING CHANGE: settings move")]).bump).toBe("major");
    expect(classify([c("chore: x"), c("test: y"), c("feat(web): z")]).bump).toBe(null);
  });
});

describe("versions", () => {
  it("follows SemVer", () => {
    expect(nextVersion("0.2.3", "patch")).toBe("0.2.4");
    expect(nextVersion("0.2.3", "minor")).toBe("0.3.0");
    expect(nextVersion("0.2.3", "major")).toBe("1.0.0");
    expect(nextVersion("1.4.2", "major")).toBe("2.0.0");
    expect(nextVersion("0.2.3", "0.5.0")).toBe("0.5.0");
  });

  it("never reaches 1.0.0 by itself: a breaking change before 1.0 is minor", () => {
    expect(autoBump("0.2.3", "major")).toBe("minor");
    expect(autoBump("1.2.3", "major")).toBe("major");
    expect(autoBump("0.2.3", "patch")).toBe("patch");
  });
});

describe("notes", () => {
  it("drafts a file that is refused until the title is written", () => {
    const text = draftText("0.3.0", "2026-11-08", { added: ["A"], improved: [], fixed: [] });
    expect(text).toContain("version: 0.3.0\ndate: 2026-11-08");
    expect(text).toContain("### New\n\n- A");
    expect(text).not.toContain("### Fixed");
    expect(() => parseNotes(text, "0.3.0")).toThrow(/title/);
    const done = text.replace(JSON.stringify(TODO_TITLE), '"Pictures in chat"');
    expect(parseNotes(done, "0.3.0")).toMatchObject({ title: "Pictures in chat", date: "2026-11-08" });
    expect(() => parseNotes(done, "0.3.1")).toThrow(/expected 0.3.1/);
  });

  it("a refactor-only release still has a section", () => {
    const text = draftText("0.2.4", "2026-11-08", { added: [], improved: [], fixed: [] }, "Smaller fixes");
    expect(parseNotes(text, "0.2.4").body).toMatch(/^### Improved/);
  });
});

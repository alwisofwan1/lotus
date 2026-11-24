import { describe, expect, it } from "vitest";
import type { CodespaceGitFileStatus } from "@/lib/tauri-api";
import {
  applyConventionalType,
  extractCommitType,
  suggestConventionalCommitHeuristic,
} from "../conventional-commit";

function status(
  partial: Pick<CodespaceGitFileStatus, "relativePath"> & Partial<CodespaceGitFileStatus>,
): CodespaceGitFileStatus {
  return {
    path: `/repo/${partial.relativePath}`,
    relativePath: partial.relativePath,
    staged: partial.staged ?? "modified",
    unstaged: partial.unstaged ?? null,
  };
}

describe("applyConventionalType", () => {
  it("prepends a type to a free-form message", () => {
    expect(applyConventionalType("rewrite parser", "feat")).toBe("feat: rewrite parser");
  });

  it("replaces an existing type while preserving scope, !, and body", () => {
    const message = "fix(parser)!: handle empty input\n\nresolves a long-standing crash";
    expect(applyConventionalType(message, "feat")).toBe(
      "feat(parser)!: handle empty input\n\nresolves a long-standing crash",
    );
  });

  it("is idempotent for the same type", () => {
    const message = "feat(ui): add chip row";
    expect(applyConventionalType(message, "feat")).toBe(message);
  });
});

describe("extractCommitType", () => {
  it("returns the type when the header is conventional", () => {
    expect(extractCommitType("docs: tweak readme")).toBe("docs");
    expect(extractCommitType("refactor(codespace): split services")).toBe("refactor");
  });

  it("returns null for free-form headers", () => {
    expect(extractCommitType("update parser")).toBeNull();
    expect(extractCommitType("")).toBeNull();
  });
});

describe("suggestConventionalCommitHeuristic", () => {
  it("returns null when nothing is staged", () => {
    expect(suggestConventionalCommitHeuristic({ rootDir: "/repo", statuses: [] })).toBeNull();
  });

  it("infers docs when only markdown changed", () => {
    const result = suggestConventionalCommitHeuristic({
      rootDir: "/repo",
      statuses: [status({ relativePath: "README.md" }), status({ relativePath: "docs/setup.md" })],
    });
    expect(result?.type).toBe("docs");
  });

  it("infers test when only test files changed", () => {
    const result = suggestConventionalCommitHeuristic({
      rootDir: "/repo",
      statuses: [
        status({ relativePath: "src/foo/__tests__/foo.test.ts" }),
        status({ relativePath: "src/bar.spec.ts" }),
      ],
    });
    expect(result?.type).toBe("test");
  });

  it("infers feat when every staged change is added", () => {
    const result = suggestConventionalCommitHeuristic({
      rootDir: "/repo",
      statuses: [
        status({ relativePath: "src/modules/codespace/components/Foo.tsx", staged: "added" }),
        status({ relativePath: "src/modules/codespace/components/Bar.tsx", staged: "added" }),
      ],
    });
    expect(result?.type).toBe("feat");
    expect(result?.scope).toBe("codespace");
    expect(result?.template).toBe("feat(codespace): ");
  });

  it("falls back to refactor on mixed modifications", () => {
    const result = suggestConventionalCommitHeuristic({
      rootDir: "/repo",
      statuses: [
        status({ relativePath: "src/lib/foo.ts", staged: "modified" }),
        status({ relativePath: "src/lib/bar.ts", staged: "modified" }),
      ],
    });
    expect(result?.type).toBe("refactor");
  });
});

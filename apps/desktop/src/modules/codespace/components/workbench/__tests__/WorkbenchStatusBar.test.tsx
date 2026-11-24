import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkbenchStatusBar } from "../WorkbenchStatusBar";

const status = { line: 18, column: 32, insertSpaces: true, tabSize: 4, eol: "LF" as const };
const git = { branch: "main", head: "abc", upstream: "origin/main", ahead: 1, behind: 0 };

const text = () => screen.getByRole("group", { name: "Editor status" }).textContent ?? "";

describe("WorkbenchStatusBar", () => {
  it("shows the file's real state, as the mockup lays it out", () => {
    render(<WorkbenchStatusBar dirty status={status} git={git} language="php" />);
    expect(screen.getByText("Unsaved · ⌘S")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByLabelText("1 commit to push")).toBeInTheDocument();
    expect(screen.getByText("Ln 18, Col 32")).toBeInTheDocument();
    expect(screen.getByText("Spaces: 4")).toBeInTheDocument();
    expect(screen.getByText("UTF-8")).toBeInTheDocument();
    expect(screen.getByText("PHP")).toBeInTheDocument();
  });

  it("says nothing it does not know", () => {
    render(<WorkbenchStatusBar dirty={false} status={null} git={null} language="typescript" />);
    expect(text()).not.toMatch(/Unsaved|Ln |Spaces|Tab Size|↑|↓/);
    expect(text()).not.toMatch(/problems/i);
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
  });

  it("shows commits to pull, and nothing for an even branch", () => {
    const { rerender } = render(<WorkbenchStatusBar dirty={false} status={status} git={{ ...git, ahead: 0, behind: 2 }} language="go" />);
    expect(screen.getByLabelText("2 commits to pull")).toBeInTheDocument();
    rerender(<WorkbenchStatusBar dirty={false} status={status} git={{ ...git, ahead: 0, behind: 0 }} language="go" />);
    expect(screen.queryByLabelText(/to (push|pull)/)).toBeNull();
  });

  it("moves with the cursor", () => {
    const { rerender } = render(<WorkbenchStatusBar dirty={false} status={status} git={null} language="go" />);
    rerender(<WorkbenchStatusBar dirty={false} status={{ ...status, line: 3, column: 7 }} git={null} language="go" />);
    expect(screen.getByText("Ln 3, Col 7")).toBeInTheDocument();
  });

  it("puts a conflict or git error where it can be read", () => {
    render(<WorkbenchStatusBar dirty={false} status={null} git={null} language={null} notice="Conflict: File has changed on disk" />);
    expect(screen.getByText("Conflict: File has changed on disk")).toBeInTheDocument();
  });

  it("speaks the notice and the git action, never the cursor", () => {
    const { rerender } = render(<WorkbenchStatusBar dirty status={status} git={git} language="go" />);
    // Mounted empty, so the text that lands in it later is announced.
    expect(screen.getByRole("status")).toHaveTextContent("");
    rerender(<WorkbenchStatusBar dirty status={{ ...status, line: 9 }} git={git} language="go" activity="Pushing…" notice="Push failed" />);
    const live = screen.getByRole("status");
    expect(live).toHaveTextContent("Pushing…");
    expect(live).toHaveTextContent("Push failed");
    expect(live).not.toHaveTextContent(/Ln |Spaces|UTF-8|main|Unsaved/);
  });
});

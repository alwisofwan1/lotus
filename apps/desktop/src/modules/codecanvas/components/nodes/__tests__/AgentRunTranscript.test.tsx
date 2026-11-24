import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AgentRunTranscript } from "../AgentRunTranscript";
import type { AgentRunEntry } from "../../../services/agent-run-view";

vi.mock("../AgentMarkdownBlock", () => ({ AgentMarkdownBlock: ({ text }: { text: string }) => <p>{text}</p> }));

const tool = (label: string): AgentRunEntry => ({ kind: "tool", label });
const prose = (text: string): AgentRunEntry => ({ kind: "message", text });
const view = (...entries: AgentRunEntry[]) => ({ entries });

describe("AgentRunTranscript busy pill", () => {
  it("says Working, with no detail, before anything is reported", () => {
    render(<AgentRunTranscript view={view()} status="connecting" />);
    expect(screen.getByRole("status")).toHaveTextContent(/^Working$/);
    expect(screen.queryByText("Working…")).not.toBeInTheDocument();
  });

  it("names the newest tool and counts every tool reported", () => {
    render(
      <AgentRunTranscript
        view={view(tool("Reading src/a.ts"), tool("Running: bun run test"))}
        status="running"
      />,
    );
    // The count is the pill's aria-hidden detail, so it sits in the status element's text.
    expect(screen.getByRole("status")).toHaveTextContent(/^Running: bun run test2 tools$/);
  });

  it("steps aside for the cursor once prose arrives", () => {
    const { container } = render(
      <AgentRunTranscript view={view(tool("Reading src/a.ts"), prose("Found it."))} status="running" />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("Found it.")).toBeInTheDocument();
    expect(container.querySelector(".agent-transcript-cursor")).not.toBeNull();
  });

  it("gives way to the tool rows when the user shows activity", () => {
    render(<AgentRunTranscript view={view(tool("Reading src/a.ts"))} status="running" />);
    fireEvent.click(screen.getByRole("button", { name: "Show tool activity" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByTitle("Reading src/a.ts")).toBeInTheDocument();
  });

  it("is idle text, not a pill, when the run is not busy", () => {
    render(<AgentRunTranscript view={view()} status="idle" />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("Ready to run.")).toBeInTheDocument();
  });
});

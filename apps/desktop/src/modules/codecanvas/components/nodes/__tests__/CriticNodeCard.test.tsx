import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CriticNodeCard } from "../CriticNodeCard";

const base = {
  title: "Gate",
  status: "idle" as const,
  verdict: null,
  onTitleChange: () => {},
  onRun: () => {},
  onStop: () => {},
  onClose: () => {},
};

describe("CriticNodeCard", () => {
  it("shows a Verify button when idle and runs it", () => {
    const onRun = vi.fn();
    render(<CriticNodeCard {...base} onRun={onRun} />);
    fireEvent.click(screen.getByLabelText("Run critic"));
    expect(onRun).toHaveBeenCalled();
  });

  it("shows a Stop button while running", () => {
    render(<CriticNodeCard {...base} status="running" />);
    expect(screen.getByLabelText("Stop critic")).toBeInTheDocument();
    expect(screen.queryByLabelText("Run critic")).not.toBeInTheDocument();
  });

  it("renders the latest verdict badge", () => {
    const { rerender } = render(<CriticNodeCard {...base} verdict="pass" />);
    expect(screen.getByText("PASS")).toBeInTheDocument();
    rerender(<CriticNodeCard {...base} verdict="fail" />);
    expect(screen.getByText("FAIL")).toBeInTheDocument();
  });

  it("edits the title", () => {
    const onTitleChange = vi.fn();
    render(<CriticNodeCard {...base} onTitleChange={onTitleChange} />);
    fireEvent.change(screen.getByLabelText("Critic name"), { target: { value: "Security" } });
    expect(onTitleChange).toHaveBeenCalledWith("Security");
  });
});

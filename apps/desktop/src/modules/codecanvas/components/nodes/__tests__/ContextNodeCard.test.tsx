import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContextNodeCard } from "../ContextNodeCard";
import { buildArtifact, type ContextArtifact } from "../../../services/context-bus-record";

const artifact = (key: string, value: string): ContextArtifact =>
  buildArtifact({ projectId: "p", busNodeId: "bus-1", key, value, producer: key, graphRunId: null, now: 1 });

describe("ContextNodeCard", () => {
  it("shows an empty hint when no artifacts have been published", () => {
    render(<ContextNodeCard title="Bus" artifacts={[]} onTitleChange={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/No artifacts yet/i)).toBeInTheDocument();
  });

  it("lists each artifact's key, producer, version, and value", () => {
    render(<ContextNodeCard title="Bus" artifacts={[artifact("Architect", "the schema")]} onTitleChange={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Architect")).toBeInTheDocument();
    expect(screen.getByText(/v1 · Architect/)).toBeInTheDocument();
    expect(screen.getByText("the schema")).toBeInTheDocument();
  });

  it("edits the bus title and closes", () => {
    const onTitleChange = vi.fn();
    const onClose = vi.fn();
    render(<ContextNodeCard title="Bus" artifacts={[]} onTitleChange={onTitleChange} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText("Context bus name"), { target: { value: "Docs" } });
    expect(onTitleChange).toHaveBeenCalledWith("Docs");
    fireEvent.click(screen.getByLabelText("Close context node"));
    expect(onClose).toHaveBeenCalled();
  });
});

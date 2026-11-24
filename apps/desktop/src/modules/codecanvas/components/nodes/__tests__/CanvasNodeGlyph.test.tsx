import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CanvasNodeGlyph, glyphInitials, glyphToneForAgentStatus } from "../CanvasNodeGlyph";

describe("glyphToneForAgentStatus", () => {
  it("mirrors each agent status onto a glyph tone", () => {
    expect(glyphToneForAgentStatus("idle")).toBe("idle");
    expect(glyphToneForAgentStatus("connecting")).toBe("pending");
    expect(glyphToneForAgentStatus("running")).toBe("active");
    expect(glyphToneForAgentStatus("completed")).toBe("done");
    expect(glyphToneForAgentStatus("error")).toBe("error");
  });
});

describe("glyphInitials", () => {
  it("uses first+last word initials for multi-word labels", () => {
    expect(glyphInitials("Frontend Specialist")).toBe("FS");
    expect(glyphInitials("Quality Assurance Lead")).toBe("QL");
  });

  it("uses the first two characters for a single word", () => {
    expect(glyphInitials("Backend")).toBe("BA");
  });

  it("never throws on an empty label", () => {
    expect(glyphInitials("   ")).toBe("··");
  });
});

describe("CanvasNodeGlyph", () => {
  it("renders a toned block with a monogram and an accessible label", () => {
    const { container } = render(<CanvasNodeGlyph label="Frontend Specialist" tone="active" detail="claude-sonnet-4-6" />);
    const block = container.querySelector(".canvas-node-glyph");
    expect(block).toHaveClass("canvas-node-glyph--active");
    expect(screen.getByText("FS")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Frontend Specialist — claude-sonnet-4-6" })).toBeInTheDocument();
  });
});

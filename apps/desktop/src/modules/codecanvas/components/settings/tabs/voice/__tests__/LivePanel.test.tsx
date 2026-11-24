import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LivePanel } from "../LivePanel";

vi.mock("../../VoiceProviderList", () => ({ VoiceProviderList: () => <div data-testid="engine-list" /> }));

describe("LivePanel", () => {
  it("keeps only the engine — Reply length moved to How voice behaves", () => {
    render(<LivePanel list={{} as never} />);
    expect(screen.queryByText("Live response detail")).not.toBeInTheDocument();
    expect(screen.getByTestId("engine-list")).toBeInTheDocument();
  });
});

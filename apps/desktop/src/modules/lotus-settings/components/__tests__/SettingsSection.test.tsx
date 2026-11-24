import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SettingsSection } from "../SettingsSection";

describe("SettingsSection", () => {
  it("renders its label and children", () => {
    render(
      <SettingsSection label="Layout">
        <button type="button">child</button>
      </SettingsSection>,
    );
    expect(screen.getByText("Layout")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "child" })).toBeInTheDocument();
  });

  it("renders an optional badge next to the label", () => {
    render(
      <SettingsSection label="Layout" badge="New">
        <span>x</span>
      </SettingsSection>,
    );
    expect(screen.getByText("New")).toBeInTheDocument();
  });

  it("renders an optional description below the label", () => {
    render(
      <SettingsSection label="Theme" description="Paper, palette, material.">
        <span>x</span>
      </SettingsSection>,
    );
    expect(screen.getByText("Paper, palette, material.")).toBeInTheDocument();
  });
});

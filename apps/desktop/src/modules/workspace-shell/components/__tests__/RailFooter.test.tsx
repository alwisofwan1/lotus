import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemeContext } from "@/contexts/ThemeContext";
import { getDesignTheme } from "@/lib/design-system";
import { RailFooter } from "../RailFooter";

function renderFooter(resolvedThemeMode: "dark" | "light") {
  const setThemePreference = vi.fn();
  render(
    <ThemeContext.Provider
      value={{
        theme: getDesignTheme(resolvedThemeMode),
        themeId: resolvedThemeMode,
        themePreference: "system",
        resolvedThemeMode,
        systemThemeMode: resolvedThemeMode,
        setThemeId: () => {},
        setThemePreference,
      }}
    >
      <RailFooter onOpenSettings={() => {}} />
    </ThemeContext.Provider>,
  );
  return setThemePreference;
}

describe("RailFooter", () => {
  it("pins the mode that is not on screen", () => {
    const setThemePreference = renderFooter("dark");
    fireEvent.click(screen.getByRole("button", { name: "Toggle theme" }));
    expect(setThemePreference).toHaveBeenCalledWith("light", { x: expect.any(Number), y: expect.any(Number) });
  });

  it("flips back from light", () => {
    const setThemePreference = renderFooter("light");
    fireEvent.click(screen.getByRole("button", { name: "Toggle theme" }));
    expect(setThemePreference).toHaveBeenCalledWith("dark", { x: expect.any(Number), y: expect.any(Number) });
  });

  it("draws the shortcut hints as keycaps", () => {
    renderFooter("dark");
    expect(screen.getByText("⌘J").tagName).toBe("KBD");
  });
});

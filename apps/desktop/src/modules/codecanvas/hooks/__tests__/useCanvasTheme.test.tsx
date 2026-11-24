import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";

import { useCanvasTheme, resetCanvasThemeStoreForTests } from "../useCanvasTheme";

class LocalStorageMock {
  private store: Record<string, string> = {};
  getItem(key: string) { return this.store[key] ?? null; }
  setItem(key: string, value: string) { this.store[key] = String(value); }
  removeItem(key: string) { delete this.store[key]; }
  clear() { this.store = {}; }
}

const THEME_KEY = "canvas-theme-id-v2";
const LEGACY_KEY = "canvas-background-theme-v1";

beforeEach(() => {
  vi.stubGlobal("localStorage", new LocalStorageMock());
  resetCanvasThemeStoreForTests();
});

function Reader() {
  const { themeId, theme } = useCanvasTheme();
  return <div data-testid="reader">{themeId}|{theme.material}|{theme.name}</div>;
}
function Writer() {
  const { setTheme } = useCanvasTheme();
  return <button onClick={() => setTheme("midnight")}>set-midnight</button>;
}
function Catalog() {
  const { themes } = useCanvasTheme();
  return <div data-testid="catalog">{themes.map((t) => t.id).join(",")}</div>;
}

describe("useCanvasTheme — shared store", () => {
  it("defaults to void (glass) when nothing is persisted", () => {
    render(<Reader />);
    expect(screen.getByTestId("reader")).toHaveTextContent("void|glass|Void");
  });

  it("propagates setTheme across consumers live and persists v2", () => {
    render(<><Reader /><Writer /></>);
    fireEvent.click(screen.getByText("set-midnight"));
    expect(screen.getByTestId("reader")).toHaveTextContent("midnight|solid|Midnight");
    expect(localStorage.getItem(THEME_KEY)).toBe("midnight");
  });

  it("hydrates a persisted v2 theme id on mount", () => {
    localStorage.setItem(THEME_KEY, "midnight");
    act(() => { resetCanvasThemeStoreForTests(); });
    render(<Reader />);
    expect(screen.getByTestId("reader")).toHaveTextContent("midnight|solid|Midnight");
  });

  it("resolves an unknown persisted id to the default theme (id retained for async user themes)", () => {
    // A persisted id may be a user theme that loads asynchronously, so the id is
    // trusted; until it resolves (or forever, if garbage) the theme falls back to Void.
    localStorage.setItem(THEME_KEY, "does-not-exist");
    act(() => { resetCanvasThemeStoreForTests(); });
    render(<Reader />);
    expect(screen.getByTestId("reader")).toHaveTextContent("does-not-exist|glass|Void");
  });

  it("migrates a legacy v1 background theme to the default and writes v2 once", () => {
    // Legacy 7 are dropped (ADR-0023) — any legacy id lands on the default theme.
    localStorage.setItem(LEGACY_KEY, "space");
    act(() => { resetCanvasThemeStoreForTests(); });
    render(<Reader />);
    expect(screen.getByTestId("reader")).toHaveTextContent("void|");
    expect(localStorage.getItem(THEME_KEY)).toBe("void");
  });

  it("exposes the built-in catalog", () => {
    render(<Catalog />);
    expect(screen.getByTestId("catalog")).toHaveTextContent("void,midnight,cobalt,lakeside,lakeside-day");
  });
});

function TextSizeReader() {
  const { nodeTextSize, effectiveTextSize } = useCanvasTheme();
  return <div data-testid="ts">{String(nodeTextSize)}|{effectiveTextSize}</div>;
}
function TextSizeWriter() {
  const { setNodeTextSize } = useCanvasTheme();
  return <button onClick={() => setNodeTextSize("xl")}>set-xl</button>;
}

describe("useCanvasTheme — node text size axis", () => {
  it("defaults to no override and an effective size of md", () => {
    render(<TextSizeReader />);
    expect(screen.getByTestId("ts")).toHaveTextContent("null|md");
  });

  it("setNodeTextSize sets the override, persists it, and drives the effective size", () => {
    render(<><TextSizeReader /><TextSizeWriter /></>);
    fireEvent.click(screen.getByText("set-xl"));
    expect(screen.getByTestId("ts")).toHaveTextContent("xl|xl");
    expect(localStorage.getItem("canvas-node-text-size-v1")).toBe("xl");
  });

  it("hydrates a persisted override on mount", () => {
    localStorage.setItem("canvas-node-text-size-v1", "sm");
    act(() => { resetCanvasThemeStoreForTests(); });
    render(<TextSizeReader />);
    expect(screen.getByTestId("ts")).toHaveTextContent("sm|sm");
  });

  it("keeps the override when the theme changes (orthogonal axis)", () => {
    render(<><TextSizeReader /><Writer /><TextSizeWriter /></>);
    fireEvent.click(screen.getByText("set-xl"));
    fireEvent.click(screen.getByText("set-midnight"));
    expect(screen.getByTestId("ts")).toHaveTextContent("xl|xl");
  });
});

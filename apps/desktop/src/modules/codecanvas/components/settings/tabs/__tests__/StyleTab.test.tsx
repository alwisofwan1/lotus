import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";

import { StyleTab } from "../StyleTab";
import { resetCanvasThemeStoreForTests } from "@/modules/codecanvas/hooks/useCanvasTheme";
import { BUILTIN_THEMES, DEFAULT_CANVAS_THEME_ID } from "@/modules/codecanvas/services/theme/builtin-themes";

class LocalStorageMock {
  private store: Record<string, string> = {};
  getItem(key: string) { return this.store[key] ?? null; }
  setItem(key: string, value: string) { this.store[key] = String(value); }
  removeItem(key: string) { delete this.store[key]; }
  clear() { this.store = {}; }
}

// User-authored themes arrive through listCanvasThemes; `userSpecs` is the seam a test uses
// to put one in the catalog. readCanvasThemeAsset would only be reached by a theme-folder
// ref, which the built-ins never use.
let userSpecs: unknown[] = [];
vi.mock("@/lib/tauri-api", () => ({
  listCanvasThemes: () => Promise.resolve(userSpecs),
  readCanvasThemeAsset: () => Promise.resolve(null),
  canvasThemeMediaUrl: () => Promise.resolve(null),
}));

beforeEach(() => {
  vi.stubGlobal("localStorage", new LocalStorageMock());
  userSpecs = [];
  resetCanvasThemeStoreForTests();
});

/** A valid user theme with NO preview asset — what an agent authors today. */
function bareUserSpec(id: string, name: string) {
  const base = { ...theme("midnight") } as Record<string, unknown>;
  delete base.origin; // stamped by the validator, never trusted from input
  delete base.preview; // the whole point: a theme with no still
  return { ...base, id, name, descriptor: "authored by an agent" };
}

const theme = (id: string) => BUILTIN_THEMES.find((t) => t.id === id)!;
const cards = () => screen.getAllByRole("radio");
const cardFor = (id: string) =>
  cards().find((c) => c.getAttribute("data-theme-id") === id)!;

describe("StyleTab theme gallery", () => {
  it("previews every theme with its rendered still, not a swatch of paper.fill", () => {
    // The regression this locks down: `paper.fill` on the three photo/video themes is an
    // admitted hand-drawn stand-in for the wallpaper, so a card painted from it showed
    // Lakeside as a plum gradient. Each card must draw the theme's own `preview` asset.
    render(<StyleTab />);
    for (const t of BUILTIN_THEMES) {
      const img = cardFor(t.id).querySelector("img");
      expect(img, `${t.id}: card has no still`).not.toBeNull();
      expect(img).toHaveAttribute("src", t.preview);
    }
  });

  it("defers off-screen card decoding so opening the tab does not decode the whole catalog", () => {
    render(<StyleTab />);
    for (const img of Array.from(document.querySelectorAll(".cc-theme-card img"))) {
      expect(img).toHaveAttribute("loading", "lazy");
      expect(img).toHaveAttribute("decoding", "async");
    }
  });

  it("falls back to a fill + palette card for a user theme with no preview asset", async () => {
    // Agent-authored themes ship no still, and this is the ONLY way that branch is reachable —
    // every built-in has one. The gallery must not have a hole where a theme should be.
    userSpecs = [bareUserSpec("bespoke", "Bespoke")];
    render(<StyleTab />);

    await waitFor(() => expect(screen.getByText("Yours")).toBeInTheDocument());
    const card = cardFor("bespoke");
    expect(card.querySelector("img")).toBeNull();
    const fill = card.querySelector(".cc-theme-card-fill") as HTMLElement;
    expect(fill).not.toBeNull();
    // Painted from the theme's own paper, and carrying its five palette roles.
    expect(fill.style.background).not.toBe("");
    expect(fill.querySelectorAll(".cc-theme-card-fill-dots > span")).toHaveLength(5);
    // Still selectable, and still reads as one choice with the built-ins.
    fireEvent.click(card);
    expect(cardFor("bespoke")).toHaveAttribute("aria-checked", "true");
  });

  it("groups the scenery themes apart from the flat surfaces", () => {
    render(<StyleTab />);
    expect(screen.getByText("Sceneries")).toBeInTheDocument();
    expect(screen.getByText("Surfaces")).toBeInTheDocument();
    // "Yours" only appears once the user has authored a theme.
    expect(screen.queryByText("Yours")).toBeNull();
    // An image paper is tagged as photo.
    expect(cardFor("lakeside")).toHaveTextContent("Photo");
    expect(cardFor("void")).not.toHaveTextContent(/Photo|Motion/);
  });

  it("selects a theme on click and marks exactly one card checked", () => {
    render(<StyleTab />);
    fireEvent.click(cardFor("lakeside"));
    expect(cardFor("lakeside")).toHaveAttribute("aria-checked", "true");
    expect(cards().filter((c) => c.getAttribute("aria-checked") === "true")).toHaveLength(1);
  });

  it("keeps one tab stop, on the selected card, instead of one per theme", () => {
    render(<StyleTab />);
    const tabbable = cards().filter((c) => c.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0].getAttribute("data-theme-id")).toBe(DEFAULT_CANVAS_THEME_ID);
  });

  it("walks the gallery with the arrow keys in visual order, wrapping at the ends", () => {
    render(<StyleTab />);
    // Visual order is sceneries first, then surfaces — NOT catalog order, so a naive
    // implementation that walked BUILTIN_THEMES would move the selection somewhere the
    // eye cannot follow. lakeside is the first scenery; arrow-right lands on the next one.
    fireEvent.click(cardFor("lakeside"));
    fireEvent.keyDown(cardFor("lakeside"), { key: "ArrowRight" });
    expect(cardFor("lakeside-day")).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(cardFor("lakeside-day"), { key: "ArrowLeft" });
    expect(cardFor("lakeside")).toHaveAttribute("aria-checked", "true");

    // Wrap: left from the first scenery lands on the last card in the gallery.
    fireEvent.keyDown(cardFor("lakeside"), { key: "ArrowLeft" });
    expect(cards().filter((c) => c.getAttribute("aria-checked") === "true")).toHaveLength(1);
    expect(cardFor("lakeside")).toHaveAttribute("aria-checked", "false");
  });

  it("exposes the gallery as one radiogroup, so a screen reader reads it as one choice", () => {
    render(<StyleTab />);
    // One group for the whole gallery, not one per section: the sections are visual
    // grouping of a single-valued choice.
    expect(screen.getAllByRole("radiogroup", { name: "Canvas theme" })).toHaveLength(1);
    expect(cards().length).toBe(BUILTIN_THEMES.length);
  });

  it("renders the text-size specimen at the size being chosen", () => {
    render(<StyleTab />);
    const sample = document.querySelector(".cc-textsize-sample") as HTMLElement;
    expect(sample).not.toBeNull();
    const before = sample.style.fontSize;
    fireEvent.click(screen.getByLabelText("Set node text size xl"));
    expect((document.querySelector(".cc-textsize-sample") as HTMLElement).style.fontSize)
      .not.toBe(before);
  });
});

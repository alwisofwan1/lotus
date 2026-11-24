import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { editorMediaType } from "@/modules/codespace/services/editor-media";
import { WorkbenchMediaPreview } from "../WorkbenchMediaPreview";

const pdfjs = vi.hoisted(() => {
  const page = { getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }) };
  return {
    GlobalWorkerOptions: {} as Record<string, unknown>,
    getDocument: vi.fn(() => ({
      promise: Promise.resolve({ numPages: 2, getPage: async () => page }),
      destroy: async () => {},
    })),
  };
});
vi.mock("pdfjs-dist", () => pdfjs);

const PNG = editorMediaType("a.png")!;
const SVG = editorMediaType("a.svg")!;

beforeEach(() => {
  let next = 0;
  URL.createObjectURL = vi.fn(() => `blob:media-${next++}`);
  URL.revokeObjectURL = vi.fn();
});

function loadImage(width: number, height: number) {
  const image = screen.getByRole("img");
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(image, "naturalHeight", { configurable: true, value: height });
  fireEvent.load(image);
  return image;
}

describe("WorkbenchMediaPreview", () => {
  it("shows a PNG from its bytes, with its size and dimensions", async () => {
    const load = vi.fn(async () => new Uint8Array(1_400_000).buffer);
    render(<WorkbenchMediaPreview fileName="fold.png" media={PNG} source={{ kind: "bytes", load, version: 0 }} />);

    expect(screen.getByText("Reading file")).toBeInTheDocument();
    await screen.findByRole("img", { name: "fold.png" });
    loadImage(640, 480);

    expect(screen.getByText(/640 × 480/)).toBeInTheDocument();
    expect(screen.getByText(/1\.4 MB/)).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("zooms with the buttons and the keyboard, and goes back to fit", async () => {
    render(<WorkbenchMediaPreview fileName="fold.png" media={PNG} source={{ kind: "bytes", load: async () => new ArrayBuffer(4), version: 0 }} />);
    await screen.findByRole("img");
    const image = loadImage(100, 50);

    // jsdom has no layout: the viewport measures 0, so fit falls back to 100%.
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(image).toHaveStyle({ width: "125px", height: "63px" });

    fireEvent.keyDown(screen.getByRole("region"), { key: "-" });
    expect(image).toHaveStyle({ width: "100px" });
    fireEvent.keyDown(screen.getByRole("region"), { key: "-" });
    expect(image).toHaveStyle({ width: "75px" });

    fireEvent.click(screen.getByRole("button", { name: "Fit to window" }));
    expect(screen.getByRole("button", { name: "Fit to window" })).toHaveAttribute("aria-pressed", "true");
  });

  it("reads the bytes again when the file changes on disk, and frees the old URL", async () => {
    const load = vi.fn(async () => new ArrayBuffer(4));
    const { rerender } = render(<WorkbenchMediaPreview fileName="a.png" media={PNG} source={{ kind: "bytes", load, version: 0 }} />);
    await screen.findByRole("img");
    rerender(<WorkbenchMediaPreview fileName="a.png" media={PNG} source={{ kind: "bytes", load, version: 1 }} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:media-0");
  });

  it("draws an SVG from the editor's text, unsaved edits included", async () => {
    render(<WorkbenchMediaPreview fileName="a.svg" media={SVG} source={{ kind: "text", text: "<svg xmlns='http://www.w3.org/2000/svg'/>" }} />);
    expect(await screen.findByRole("img", { name: "a.svg" })).toHaveAttribute("src", "blob:media-0");
  });

  it("says why when the file cannot be read or decoded", async () => {
    render(<WorkbenchMediaPreview fileName="huge.png" media={PNG} source={{ kind: "bytes", load: async () => { throw new Error("File is too large to preview"); }, version: 0 }} />);
    expect(await screen.findByText("Cannot preview huge.png")).toBeInTheDocument();
    expect(screen.getByText("File is too large to preview")).toBeInTheDocument();
  });

  it("shows a decode failure instead of a broken image", async () => {
    render(<WorkbenchMediaPreview fileName="bad.png" media={PNG} source={{ kind: "bytes", load: async () => new ArrayBuffer(4), version: 0 }} />);
    const image = await screen.findByRole("img");
    act(() => {
      fireEvent.error(image);
    });
    expect(screen.getByText("Cannot display bad.png")).toBeInTheDocument();
  });
});

describe("PDF and fonts", () => {
  it("draws a PDF's pages itself, sized from the file, with a page count", async () => {
    vi.stubGlobal("Worker", class {});
    render(<WorkbenchMediaPreview fileName="spec.pdf" media={editorMediaType("spec.pdf")!} source={{ kind: "bytes", load: async () => new ArrayBuffer(8), version: 0 }} />);
    expect(await screen.findByText("1 / 2")).toBeInTheDocument();
    expect(screen.getByLabelText("Page 1")).toBeInTheDocument();
    expect(screen.getByLabelText("Page 2")).toBeInTheDocument();
    expect(pdfjs.getDocument).toHaveBeenCalledWith({ data: expect.any(Uint8Array) });
    // Never WebKit's own viewer: it paints a white well around the pages.
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("loads a font under a name of its own and shows samples, then lets it go", async () => {
    const added: unknown[] = [];
    const deleted: unknown[] = [];
    class FakeFontFace {
      constructor(readonly family: string, readonly source: string) {}
      load() {
        return Promise.resolve(this);
      }
    }
    vi.stubGlobal("FontFace", FakeFontFace);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { add: (face: unknown) => added.push(face), delete: (face: unknown) => deleted.push(face) },
    });
    const { unmount } = render(
      <WorkbenchMediaPreview fileName="Brand.woff2" media={editorMediaType("Brand.woff2")!} source={{ kind: "bytes", load: async () => new ArrayBuffer(8), version: 0 }} />,
    );
    await waitFor(() => expect(added).toHaveLength(1));
    const face = added[0] as FakeFontFace;
    expect(face.family).toMatch(/^lotus-font-preview-/);
    expect(face.source).toMatch(/^url\(blob:media-/);
    // WOFF2 is compressed: no names are read, the file name stands in.
    expect(screen.getByRole("heading", { name: "Brand.woff2" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Sample text" }), { target: { value: "Lotus" } });
    expect(screen.getAllByText("Lotus")).toHaveLength(6);
    unmount();
    expect(deleted).toEqual([face]);
    vi.unstubAllGlobals();
  });

  it("says so when a font cannot be loaded", async () => {
    vi.stubGlobal("FontFace", class {
      load() {
        return Promise.reject(new Error("bad"));
      }
    });
    Object.defineProperty(document, "fonts", { configurable: true, value: { add: vi.fn(), delete: vi.fn() } });
    render(<WorkbenchMediaPreview fileName="x.ttf" media={editorMediaType("x.ttf")!} source={{ kind: "bytes", load: async () => new ArrayBuffer(8), version: 0 }} />);
    expect(await screen.findByText("Cannot display x.ttf")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});

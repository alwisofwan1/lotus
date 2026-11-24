import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// LOT2-113: findBy*/waitFor gave up after the default 1 s under load ("Unable to find …") and
// passed alone. Waiting stops as soon as the element appears, so only a failing wait gets longer.
configure({ asyncUtilTimeout: 5_000 });

// The graph-run slot pool sizes itself from the host's cores (cores - 2): a 4-core CI runner got 2
// slots and 12 graph-run tests went red. Pin it so the suite means the same on every machine.
Object.defineProperty(navigator, "hardwareConcurrency", { value: 10, configurable: true });

// Mock localStorage (jsdom's localStorage may not work properly with vitest)
const store: Record<string, string> = {};
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach((k) => delete store[k]); },
    get length() { return Object.keys(store).length; },
    key: (index: number) => Object.keys(store)[index] ?? null,
  },
  writable: true,
});

// Composer drafts persist per thread id; one test's typing must not show up in the next test's composer.
afterEach(() => {
  Object.keys(store).filter((k) => k.startsWith("lotus.chat.draft.")).forEach((k) => delete store[k]);
});

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

// Mock next/link as a simple anchor
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode; [key: string]: unknown }) => {
    return <a href={href} {...props}>{children}</a>;
  },
}));

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// react-resizable-panels uses ResizeObserver; JSDOM doesn't include it
global.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// ProseMirror/Tiptap + the floating-ui BubbleMenu call getClientRects()/getBoundingClientRect()
// on nodes and ranges when positioning the menu and scrolling the caret into view. JSDOM omits
// these on some node types, throwing unhandled errors. Stub zero-sized geometry (layout is 0×0 in
// JSDOM anyway) so editor transactions in tests don't surface false errors.
const emptyRectList = Object.assign([] as DOMRect[], { item: () => null }) as unknown as DOMRectList;
const zeroRect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
// Node.prototype is the catch-all (Text nodes, which Tiptap's coords logic can hit, have
// neither method); Element/Range keep JSDOM's own where present via the missing-only guard.
for (const proto of [Node.prototype, Element.prototype, Range.prototype] as const) {
  if (typeof (proto as { getClientRects?: unknown }).getClientRects !== "function") {
    (proto as { getClientRects: () => DOMRectList }).getClientRects = () => emptyRectList;
  }
  if (typeof (proto as { getBoundingClientRect?: unknown }).getBoundingClientRect !== "function") {
    (proto as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => zeroRect;
  }
}

// ProseMirror asks `document.elementFromPoint` where a coordinate lands (caret placement, the
// table plugin's hover handling). JSDOM does no layout and has no such method; nothing is at any
// point in a 0×0 page, which is exactly what `null` says.
if (typeof document !== "undefined" && typeof document.elementFromPoint !== "function") {
  (document as { elementFromPoint: (x: number, y: number) => Element | null }).elementFromPoint = () => null;
}

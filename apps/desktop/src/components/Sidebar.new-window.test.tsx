import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mockOpenNewWindow = vi.fn<(path?: string) => Promise<void>>(() => Promise.resolve());
const mockSetCurrentWindowTitle = vi.fn<(title: string) => Promise<void>>(() => Promise.resolve());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/teams",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/tauri-api", () => ({
  openNewWindow: (path?: string) => mockOpenNewWindow(path),
  setCurrentWindowTitle: (title: string) => mockSetCurrentWindowTitle(title),
  isTauri: () => false,
  getSettings: vi.fn(() => Promise.resolve({})),
  // Read at import by runner-registry-cache (pulled in through the shell); never called here.
  listRunners: vi.fn(() => Promise.resolve({ runners: [] })),
  getRunner: vi.fn(() => Promise.resolve(null)),
}));

import { AppShell } from "@/modules/shell";

describe("Sidebar new window action", () => {
  it("opens a new window for the current route", () => {
    render(
      <AppShell>
        <div>child</div>
      </AppShell>,
    );

    fireEvent.click(screen.getByRole("button", { name: /new window/i }));

    expect(mockOpenNewWindow).toHaveBeenCalledWith("/teams");
  });
});

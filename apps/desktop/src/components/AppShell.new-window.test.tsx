import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUsePathname = vi.fn(() => "/teams");
const mockOpenNewWindow = vi.fn<(path?: string) => Promise<void>>(() => Promise.resolve());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => mockUsePathname(),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/modules/workspace-shell/containers/WorkspaceShellPage", () => ({
  WorkspaceShellPage: ({ shown }: { shown?: boolean }) => (
    <section data-testid="workspace-shell-host" data-shown={shown ? "true" : "false"}>Shell</section>
  ),
}));

vi.mock("@/lib/tauri-api", () => ({
  openNewWindow: (path?: string) => mockOpenNewWindow(path),
  isTauri: () => false,
  setCurrentWindowTitle: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  getSettings: vi.fn(() => Promise.resolve({})),
}));

import { AppShell } from "@/modules/shell";

describe("AppShell new window shortcut", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePathname.mockReturnValue("/teams");
  });

  it("opens a new window on Cmd/Ctrl+N", () => {
    render(
      <AppShell>
        <div>child</div>
      </AppShell>,
    );

    fireEvent.keyDown(window, { key: "n", metaKey: true });

    expect(mockOpenNewWindow).toHaveBeenCalledTimes(1);
    expect(mockOpenNewWindow).toHaveBeenCalledWith("/teams");
  });
});

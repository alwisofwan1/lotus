import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockUsePathname = vi.fn(() => "/canvas");
const mockOpenNewWindow = vi.fn<(path?: string) => Promise<void>>(() => Promise.resolve());
const mockSetCurrentWindowTitle = vi.fn<(title: string) => Promise<void>>(() => Promise.resolve());
const mockIsTauri = vi.fn(() => true);

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
  setCurrentWindowTitle: (title: string) => mockSetCurrentWindowTitle(title),
  isTauri: () => mockIsTauri(),
  getSettings: vi.fn(() => Promise.resolve({})),
}));

import { AppShell } from "@/modules/shell";

describe("AppShell reload shortcut guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUsePathname.mockReturnValue("/canvas");
    mockIsTauri.mockReturnValue(true);
    vi.stubEnv("NODE_ENV", "production");
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("blocks Cmd/Ctrl+R in Tauri production", async () => {
    render(
      <AppShell>
        <div>child</div>
      </AppShell>,
    );

    await waitFor(() => {
      const event = new KeyboardEvent("keydown", {
        key: "r",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });

      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  it("keeps Ctrl+R available inside terminal input", async () => {
    render(
      <AppShell>
        <div>child</div>
      </AppShell>,
    );

    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const input = document.createElement("textarea");
    xterm.appendChild(input);
    document.body.appendChild(xterm);

    await waitFor(() => {
      const event = new KeyboardEvent("keydown", {
        key: "r",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });

      input.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    });
  });
});

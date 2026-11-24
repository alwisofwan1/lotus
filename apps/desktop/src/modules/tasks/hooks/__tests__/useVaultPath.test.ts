import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, saved: [] as Record<string, unknown>[], release: () => {} }));

vi.mock("@/lib/tauri/runtime", () => ({ isTauri: () => true }));
vi.mock("@/lib/tauri-api", () => ({
  getSettings: vi.fn(async () => disk.settings),
  // Held until the test lets it finish, so what is on screen BEFORE the file is written can be seen.
  saveSettings: vi.fn(
    (next: Record<string, unknown>) =>
      new Promise<void>((resolve) => {
        disk.release = () => {
          disk.settings = next;
          disk.saved.push(next);
          resolve();
        };
      }),
  ),
}));

import { useVaultPath } from "@/modules/tasks/hooks/useVaultPath";

const repo = { id: "github-alwisofwan1-nyora", kind: "github" as const, account: "alwisofwan1", repo: "alwisofwan1/nyora", name: "alwisofwan1/nyora" };

describe("adding a GitHub source", () => {
  beforeEach(() => {
    disk.settings = {};
    disk.saved = [];
  });

  // Its first sync starts the moment it is on screen, and Rust reads the source from the file.
  it("shows the repo only once settings.json holds it", async () => {
    const { result } = renderHook(() => useVaultPath());
    await act(async () => {
      await Promise.resolve();
    });

    act(() => result.current.addGitHubSource(repo));
    await waitFor(() => expect(typeof disk.release).toBe("function"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.sources).toEqual([]);

    await act(async () => disk.release());
    await waitFor(() => expect(result.current.sources).toEqual([repo]));
    expect(disk.saved[0]?.ticketSources).toEqual([repo]);
  });
});

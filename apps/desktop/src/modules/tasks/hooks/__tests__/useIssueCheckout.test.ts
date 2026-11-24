import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useIssueCheckout } from "../useIssueCheckout";

const workspaces = () => [
  { id: "w1", cwd: "/code", remote: false },
  { id: "w2", cwd: "/far", remote: true },
];

describe("useIssueCheckout", () => {
  it("asks for the repo among the local workspaces, namesakes allowed, and answers for that repo only", async () => {
    const find = vi.fn(async (repo: string) => (repo === "o/a" ? { workspaceId: "w1", cwd: "/code/a" } : null));
    const { result, rerender } = renderHook(({ repo }) => useIssueCheckout(repo, workspaces, "w1", find), {
      initialProps: { repo: "o/a" as string | null },
    });
    await waitFor(() => expect(result.current).toEqual({ workspaceId: "w1", cwd: "/code/a" }));
    expect(find).toHaveBeenCalledWith("o/a", [{ id: "w1", cwd: "/code" }], "w1", { namesake: true });

    rerender({ repo: "o/b" });
    expect(result.current).toBeNull();
    rerender({ repo: null });
    expect(result.current).toBeNull();
  });

  it("is null when the lookup fails, even by throwing outright", async () => {
    const find = vi.fn(() => {
      throw new Error("not in Tauri");
    });
    const { result } = renderHook(() => useIssueCheckout("o/a", workspaces, null, find));
    await waitFor(() => expect(find).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });
});

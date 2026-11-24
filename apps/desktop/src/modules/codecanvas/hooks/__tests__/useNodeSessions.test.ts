import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useNodeSessions } from "../useNodeSessions";
import { buildSessionRecord } from "../../services/session-record";
import { createInMemoryCanvasSessionStore } from "../../services/session-store";

describe("useNodeSessions", () => {
  it("finds the row capture wrote after mount once the node's pointer moves to it", async () => {
    const store = createInMemoryCanvasSessionStore();
    const { result, rerender } = renderHook(
      ({ pointer }: { pointer: string | null }) => useNodeSessions("p1", "n1", { activeProviderSessionId: pointer, store }),
      { initialProps: { pointer: null as string | null } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions).toEqual([]);

    // CanvasPage writes the row first, then patches the node's pointer.
    const row = { ...buildSessionRecord({ projectId: "p1", nodeId: "n1", cwd: "/x" }), providerSessionId: "cli-1" };
    await store.upsert(row);
    rerender({ pointer: "cli-1" });

    await waitFor(() => expect(result.current.activeSessionId).toBe(row.id));
  });
});

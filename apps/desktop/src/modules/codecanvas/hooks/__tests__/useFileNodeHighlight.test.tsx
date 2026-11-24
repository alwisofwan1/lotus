import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const pending: Array<{ text: string; resolve: (lines: unknown) => void }> = [];

vi.mock("@/modules/codespace/services/monaco-theme", () => ({
  getCodespaceMonacoThemeName: () => "theme",
  highlightCodespaceLines: (text: string) => new Promise((resolve) => pending.push({ text, resolve })),
}));
vi.mock("@/modules/codespace/hooks/useEditorPreferences", () => ({
  useEditorPreferences: () => [{ editorDarkTheme: "d", editorLightTheme: "l" }],
}));
vi.mock("../useCanvasTheme", () => ({ useCanvasTheme: () => ({ theme: { mode: "dark" } }) }));

import { useFileNodeHighlight } from "../useFileNode";

const run = (text: string) => [[{ content: text, color: "#fff" }]];

describe("useFileNodeHighlight", () => {
  it("gives no tokens for content they were not made for, so stale code never draws", async () => {
    const { result, rerender } = renderHook(({ content }) => useFileNodeHighlight(content, "/repo/a.ts"), {
      initialProps: { content: "one" as string | null },
    });
    expect(result.current).toBeNull();
    await act(async () => pending[0].resolve(run("one")));
    expect(result.current).toEqual(run("one"));

    rerender({ content: "two" });
    // The highlight for "two" has not resolved yet: the runs of "one" must not stand in for it.
    expect(result.current).toBeNull();
    await act(async () => pending[1].resolve(run("two")));
    expect(result.current).toEqual(run("two"));
  });
});

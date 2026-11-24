import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useTerminalV2Suggestions } from "../useTerminalV2Suggestions";

describe("useTerminalV2Suggestions", () => {
  it("forwards and stores suggestion remainder changes", () => {
    const onSuggestionRemainderChange = vi.fn();

    const { result } = renderHook(() => useTerminalV2Suggestions({ onSuggestionRemainderChange }));
    result.current.suggestionAdapter.remainderChanged("npm test");

    expect(onSuggestionRemainderChange).toHaveBeenCalledWith("npm test");
    expect(result.current.getRemainder()).toBe("npm test");
  });

  it("forwards suggestion layout changes", () => {
    const onSuggestionLayoutChange = vi.fn();

    const { result } = renderHook(() => useTerminalV2Suggestions({ onSuggestionLayoutChange }));
    result.current.suggestionAdapter.layoutChanged();

    expect(onSuggestionLayoutChange).toHaveBeenCalledOnce();
  });
});

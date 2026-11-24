import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatApiProviders } from "../ModelRegistrySection";

const registry = vi.hoisted(() => ({ upsertProvider: vi.fn(async () => {}), deleteProvider: vi.fn(async () => {}) }));
vi.mock("@/modules/settings/hooks/useModelRegistry", () => ({
  useModelRegistry: () => ({ providers: [], loading: false, error: null, ...registry }),
}));
vi.mock("@/modules/chat/runtime/chat-runtime-client", () => ({ fetchApiModels: vi.fn() }));

describe("Settings › Chat › Accounts: API providers", () => {
  it("adds a provider in the page, not in a dialog over Settings, with only what Chat needs", async () => {
    const onChange = vi.fn();
    render(<ChatApiProviders onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("group", { name: "Add an API provider" })).toBeTruthy();
    expect(screen.queryByText("ID")).toBeNull();
    expect(screen.queryByText("Vendor")).toBeNull();
    expect(screen.queryByText("Type")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "DeepSeek" }));
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    expect(registry.upsertProvider).toHaveBeenCalledWith(
      expect.objectContaining({ name: "DeepSeek", type: "openai-compat", baseUrl: "https://api.deepseek.com" }),
    );
    expect(screen.queryByRole("group", { name: "Add an API provider" })).toBeNull();
  });

  it("cancels back to the Add button", () => {
    render(<ChatApiProviders onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Add provider" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Add an API provider" })).toBeNull();
  });
});

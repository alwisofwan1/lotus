import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { accountLine, ClaudeAccount } from "../ChatAuth";

const client = vi.hoisted(() => ({
  getChatAuth: vi.fn(),
  saveChatApiKey: vi.fn(),
  removeChatApiKey: vi.fn(),
  setChatAuthMode: vi.fn(),
  listChatModels: vi.fn(),
}));
vi.mock("../../runtime/chat-runtime-client", () => client);

describe("Settings › Chat › Accounts: Claude", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.getChatAuth.mockResolvedValue({ mode: "login", keyHint: null, storedInFile: null });
  });

  it("shows the key field only after API key is picked, and switches once a key is saved", async () => {
    client.saveChatApiKey.mockResolvedValue({ mode: "apiKey", keyHint: "4f2a", storedInFile: null });
    render(<ClaudeAccount />);
    expect(await screen.findByText(/Using your Claude login/)).toBeTruthy();
    expect(screen.queryByLabelText("Anthropic API key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "API key" }));
    expect(screen.getByText("Paste a key to switch to it")).toBeTruthy();
    expect(client.setChatAuthMode).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-ant-api03-x-4f2a" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(client.saveChatApiKey).toHaveBeenCalledWith("sk-ant-api03-x-4f2a");
    expect(await screen.findByText("sk-ant-…4f2a")).toBeTruthy();
    expect(screen.getByText(/Using your API key/)).toBeTruthy();
    expect(screen.getByText("macOS Keychain")).toBeTruthy();
  });

  it("cancels a key it was never given, staying on the login", async () => {
    render(<ClaudeAccount />);
    fireEvent.click(await screen.findByRole("button", { name: "API key" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Anthropic API key")).toBeNull();
    expect(screen.getByText(/Using your Claude login/)).toBeTruthy();
  });

  it("switches back to the login without losing the key", async () => {
    client.getChatAuth.mockResolvedValue({ mode: "apiKey", keyHint: "4f2a", storedInFile: null });
    client.setChatAuthMode.mockResolvedValue({ mode: "login", keyHint: "4f2a", storedInFile: null });
    render(<ClaudeAccount />);
    fireEvent.click(await screen.findByRole("button", { name: "Claude login" }));
    expect(client.setChatAuthMode).toHaveBeenCalledWith("login");
    expect(await screen.findByText(/Using your Claude login/)).toBeTruthy();
    expect(screen.getByText("sk-ant-…4f2a")).toBeTruthy();
  });

  it("says so when a dev build keeps the key in a file", async () => {
    client.getChatAuth.mockResolvedValue({ mode: "apiKey", keyHint: "4f2a", storedInFile: "/u/.lotus-dev/dev-secrets.json" });
    render(<ClaudeAccount />);
    const where = await screen.findByText("Dev build file · dev-secrets.json");
    expect(where.getAttribute("title")).toBe("/u/.lotus-dev/dev-secrets.json");
  });
});

describe("the sign-in line under the model picker", () => {
  it("names what the agent used", () => {
    expect(accountLine("claude", "accountLogin", null)).toEqual({ label: "Claude login", mismatch: false });
    expect(accountLine("claude", "apiKey", "apiKey")).toEqual({ label: "API key", mismatch: false });
    expect(accountLine("codex", "accountLogin", null)).toEqual({ label: "ChatGPT login", mismatch: false });
    expect(accountLine("codex", "apiKey", null)).toEqual({ label: "OpenAI API key", mismatch: false });
  });

  it("warns when Claude used something other than what Lotus asked for", () => {
    expect(accountLine("claude", "accountLogin", "apiKey")).toEqual({ label: "Used your login, not the API key", mismatch: true });
    expect(accountLine("claude", "apiKey", "accountLogin")).toEqual({ label: "Used an API key, not your login", mismatch: true });
  });

  it("has nothing to say before the agent reports, or for the API runner", () => {
    expect(accountLine("claude", "unknown", "apiKey")).toBeNull();
    expect(accountLine("api", "unknown", null)).toBeNull();
  });
});

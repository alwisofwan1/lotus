import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ChatModelPicker, forgetChatModels, useChatModels } from "../ChatModel";

const client = vi.hoisted(() => ({ listChatModels: vi.fn() }));
vi.mock("../../runtime/chat-runtime-client", () => client);

function Names() {
  const { models } = useChatModels("claude");
  return <p>{models.map((m) => m.displayName).join(",") || "none"}</p>;
}

describe("the runner's model list", () => {
  it("asks again after a sign-in change, so an open picker shows the new sign-in's models", async () => {
    client.listChatModels.mockResolvedValueOnce([{ value: "opus", displayName: "Opus", description: "" }]);
    render(<Names />);
    expect(await screen.findByText("Opus")).toBeTruthy();

    client.listChatModels.mockResolvedValueOnce([{ value: "sonnet", displayName: "Sonnet", description: "" }]);
    act(() => forgetChatModels());
    expect(await screen.findByText("Sonnet")).toBeTruthy();
    expect(client.listChatModels).toHaveBeenCalledTimes(2);
  });
});

describe("the model picker in a running chat", () => {
  beforeEach(() => forgetChatModels());
  const MODELS = [
    { value: "gpt-a", displayName: "GPT A", description: "Frontier", isDefault: true, efforts: ["low", "high"], defaultEffort: "low" },
    { value: "gpt-b", displayName: "GPT B", description: "Faster" },
  ];

  it("lists this chat's models by name, and warns only when the sign-in is not the one asked for", () => {
    const onManage = vi.fn();
    const { rerender } = render(
      <ChatModelPicker models={MODELS} error={null} current="gpt-a" runner="codex" account={{ label: "ChatGPT login", mismatch: false }} onManage={onManage} onPick={async () => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /GPT A/ }));
    expect(screen.getByText("Model")).toBeTruthy();
    expect(screen.queryByText("Frontier")).toBeNull();
    expect(screen.queryByText("ChatGPT login")).toBeNull();
    rerender(
      <ChatModelPicker models={MODELS} error={null} current="gpt-a" runner="codex" account={{ label: "Used your login, not the API key", mismatch: true }} onManage={onManage} onPick={async () => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(onManage).toHaveBeenCalledOnce();
  });

  it("hands off to a new chat like bb: another agent's tab, then one of its models", async () => {
    client.listChatModels.mockResolvedValue([{ value: "opus", displayName: "Opus", description: "" }]);
    const onHandoff = vi.fn();
    render(<ChatModelPicker models={MODELS} error={null} current="gpt-a" runner="codex" onHandoff={onHandoff} onPick={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /GPT A/ }));
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(screen.getByText("Handoff to new chat")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Opus" }));
    expect(onHandoff).toHaveBeenCalledWith({ runner: "claude", model: "opus", label: "Opus", effort: undefined, provider: undefined });
    expect(screen.queryByRole("dialog", { name: "Model" })).toBeNull();
  });

  it("leaves handoff with its close button, back to this chat's models", () => {
    render(<ChatModelPicker models={MODELS} error={null} current="gpt-a" runner="codex" onHandoff={() => {}} onPick={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /GPT A/ }));
    fireEvent.click(screen.getByRole("button", { name: "Handoff to new chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Exit handoff" }));
    expect(screen.getByRole("button", { name: "GPT B" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Handoff to new chat" })).toBeTruthy();
  });

  it("filters a long list with search", () => {
    const many = ["A", "B", "C", "D", "E", "F"].map((n) => ({ value: n.toLowerCase(), displayName: `Model ${n}`, description: "" }));
    render(<ChatModelPicker models={many} error={null} current="a" runner="claude" onPick={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Model A/ }));
    fireEvent.change(screen.getByPlaceholderText("Search models"), { target: { value: "model e" } });
    expect(screen.getByRole("button", { name: "Model E" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Model B" })).toBeNull();
  });

  it("still offers every agent on the new-chat screen", () => {
    render(<ChatModelPicker models={MODELS} error={null} current={null} runner="codex" onRunner={() => {}} onPick={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /GPT A/ }));
    expect(screen.getByRole("group", { name: "Agent" })).toBeTruthy();
  });
});

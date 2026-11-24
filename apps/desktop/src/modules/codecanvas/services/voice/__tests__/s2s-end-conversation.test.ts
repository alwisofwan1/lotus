import { describe, expect, it } from "vitest";
import {
  S2S_END_CONVERSATION_TOOL,
  S2S_END_CONVERSATION_TOOL_NAME,
  isS2sEndConversationCall,
  resolveS2sEndFarewell,
} from "../s2s-end-conversation";

describe("S2S end_conversation tool", () => {
  it("advertises a realtime function tool the model can call to end the session", () => {
    expect(S2S_END_CONVERSATION_TOOL_NAME).toBe("end_conversation");
    expect(S2S_END_CONVERSATION_TOOL.type).toBe("function");
    expect(S2S_END_CONVERSATION_TOOL.name).toBe("end_conversation");
    expect(S2S_END_CONVERSATION_TOOL.description).toMatch(/end|close|stop/i);
    const props = S2S_END_CONVERSATION_TOOL.parameters.properties as Record<string, unknown>;
    expect(props).toHaveProperty("farewell");
  });

  it("recognizes the end_conversation tool call by name", () => {
    expect(isS2sEndConversationCall("end_conversation")).toBe(true);
    expect(isS2sEndConversationCall("close")).toBe(false);
    expect(isS2sEndConversationCall("spawn_agent")).toBe(false);
  });

  it("uses the model's farewell phrase when provided", () => {
    expect(resolveS2sEndFarewell({ farewell: "Sure — closing live voice. Bye!" })).toBe(
      "Sure — closing live voice. Bye!",
    );
    expect(resolveS2sEndFarewell({ farewell: "  Sampai jumpa!  " })).toBe("Sampai jumpa!");
  });

  it("falls back to a default farewell when the model omits or blanks it", () => {
    expect(resolveS2sEndFarewell({})).toMatch(/\S/);
    expect(resolveS2sEndFarewell({ farewell: "   " })).toBe(resolveS2sEndFarewell({}));
    expect(resolveS2sEndFarewell({ farewell: 42 })).toBe(resolveS2sEndFarewell({}));
  });
});

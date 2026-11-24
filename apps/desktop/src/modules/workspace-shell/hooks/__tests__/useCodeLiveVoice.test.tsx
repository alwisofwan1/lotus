import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RealtimeTool } from "@/modules/codecanvas/services/voice/s2s-concierge-bridge";
import type { CodeLiveVoiceDeps } from "../../services/code-live-voice-tools";
import type { CodeVoicePane } from "../../services/code-voice-adapter";
import { useCodeLiveVoice } from "../useCodeLiveVoice";

const advertised: { tools?: RealtimeTool[]; instructions?: string } = {};

vi.mock("@/modules/codecanvas/hooks/useCanvasBehaviorSettings", () => ({
  useCanvasBehaviorSettings: () => ({ voiceAutoCloseAfterCommand: false }),
}));
vi.mock("@/modules/codecanvas/services/voice/use-command-bar-live-voice", () => ({
  useCommandBarLiveVoice: (opts: { realtimeTools?: RealtimeTool[]; instructions?: string }) => {
    advertised.tools = opts.realtimeTools;
    advertised.instructions = opts.instructions;
    return { available: true, active: false, phase: "idle", turn: 0, providerName: "Test", agentSpeaking: false, start: vi.fn(), stop: vi.fn(), interrupt: vi.fn() };
  },
}));

function deps(panes: CodeVoicePane[]): CodeLiveVoiceDeps {
  return {
    getPanes: () => panes,
    focusedId: () => panes.at(-1)?.id ?? null,
    focus: vi.fn(),
    send: vi.fn(async () => ({ ok: true as const })),
    launchable: () => ["Claude Code"],
    spawn: vi.fn(() => null),
  };
}

function agentNames(): unknown {
  const tool = advertised.tools?.find((candidate) => candidate.name === "say_to_agent") as
    | { parameters: { properties: { target: { enum: string[] } } } }
    | undefined;
  return tool?.parameters.properties.target.enum;
}

describe("useCodeLiveVoice", () => {
  // A spawned agent arrives as a new render. The provider must be told about it in that render, not
  // one render later — the next render has the same panes, so it would never be told at all.
  it("advertises a pane in the render it appears in", () => {
    const soren: CodeVoicePane = { id: "p1", name: "Soren", kind: "terminal" };
    const zia: CodeVoicePane = { id: "p2", name: "Zia", kind: "terminal" };
    const { rerender } = renderHook((props: { panes: CodeVoicePane[] }) => useCodeLiveVoice(deps(props.panes)), {
      initialProps: { panes: [soren] },
    });
    expect(agentNames()).toEqual(["Soren"]);

    rerender({ panes: [soren, zia] });
    expect(agentNames()).toEqual(["Soren", "Zia"]);
    expect(advertised.instructions).toContain("The focused pane is Zia.");

    rerender({ panes: [soren, zia] });
    expect(agentNames()).toEqual(["Soren", "Zia"]);
  });
});

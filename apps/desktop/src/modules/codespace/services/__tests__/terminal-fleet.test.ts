import { describe, expect, it } from "vitest";
import {
  buildAgentCommands,
  deriveSavedTerminalCommandName,
  ensureUniqueSavedTerminalCommandName,
  getFleetAgentDefinitions,
  getSavedTerminalCommandsFromSettings,
  mergeSavedTerminalCommandsIntoSettings,
} from "../terminal-fleet";

describe("terminal fleet helpers", () => {
  it("reads saved commands from settings and ignores invalid entries", () => {
    const commands = getSavedTerminalCommandsFromSettings({
      terminal: {
        savedCommands: [
          { id: "custom:qa", name: "QA Bot", command: "bun x qa-bot" },
          { id: "custom:qa", name: "Duplicate", command: "ignored" },
          { id: "", name: "Broken", command: "" },
        ],
      },
    });

    expect(commands).toEqual([
      { id: "custom:qa", name: "QA Bot", command: "bun x qa-bot" },
    ]);
  });

  it("merges saved commands back into settings without dropping sibling keys", () => {
    const settings = mergeSavedTerminalCommandsIntoSettings(
      { env: { LOTUS: "1" }, terminal: { savedCommands: [] } },
      [{ id: "custom:ops", name: "Ops", command: "ops-agent" }],
    );

    expect(settings).toEqual({
      env: { LOTUS: "1" },
      terminal: {
        savedCommands: [{ id: "custom:ops", name: "Ops", command: "ops-agent" }],
      },
    });
  });

  it("preserves saved command ids so edited commands keep stable references", () => {
    const original = [{ id: "custom:ops", name: "Ops", command: "ops-agent" }];
    const edited = original.map((entry) => (
      entry.id === "custom:ops" ? { ...entry, name: "Ops v2", command: "ops-agent --fast" } : entry
    ));

    expect(edited).toEqual([
      { id: "custom:ops", name: "Ops v2", command: "ops-agent --fast" },
    ]);
  });

  it("includes saved commands and detached preset commands in the fleet catalog", () => {
    const definitions = getFleetAgentDefinitions(
      [{ id: "custom:ops", name: "Ops", command: "ops-agent" }],
      {
        agentSlots: { "custom:ops": 1, custom: 1 },
        customCommands: { custom: "legacy-agent" },
        customCommandNames: { custom: "Legacy Agent" },
      },
    );

    expect(definitions.map((definition) => definition.id)).toEqual(
      expect.arrayContaining(["claude", "codex", "custom:ops", "custom"]),
    );
    expect(definitions.find((definition) => definition.id === "custom")).toMatchObject({
      name: "Legacy Agent",
      command: "legacy-agent",
      isCustom: true,
    });
  });

  it("builds launch commands from built-in and saved custom agent slots", () => {
    const definitions = getFleetAgentDefinitions([
      { id: "custom:qa", name: "QA Bot", command: "bun x qa-bot" },
    ]);

    expect(
      buildAgentCommands(
        {
          codex: 1,
          "custom:qa": 2,
        },
        definitions,
        4,
      ),
    ).toEqual(["codex", "bun x qa-bot", "bun x qa-bot", ""]);
  });

  it("derives a readable saved command name from common launcher wrappers", () => {
    expect(deriveSavedTerminalCommandName("bun x my-agent --profile prod")).toBe("My Agent");
    expect(deriveSavedTerminalCommandName("npx playwright-mcp")).toBe("Playwright Mcp");
  });

  it("ensures generated saved command names stay unique", () => {
    expect(
      ensureUniqueSavedTerminalCommandName("QA Bot", [
        { id: "custom:qa", name: "QA Bot", command: "bun x qa-bot" },
      ]),
    ).toBe("QA Bot 2");
  });
});

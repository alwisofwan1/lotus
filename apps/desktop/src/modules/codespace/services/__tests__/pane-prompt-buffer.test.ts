import { afterEach, describe, expect, it } from "vitest";
import {
  clearAllPanePrompts,
  clearPanePrompt,
  getPanePromptCount,
  getPanePromptTail,
  recordPanePrompt,
  seedPanePrompt,
  subscribePanePromptBuffer,
} from "@/modules/codespace/services/pane-prompt-buffer";
import { createCellBus } from "@/modules/codespace/services/bridge/cell-event-bus";
import { DEFAULT_TERMINAL_INPUT_METADATA } from "@/modules/codespace/services/terminal-input-events";

afterEach(() => {
  clearAllPanePrompts();
});

describe("pane-prompt-buffer", () => {
  describe("recordPanePrompt", () => {
    it("stores a prompt that can be read back", () => {
      recordPanePrompt("pane-1", "deploy the staging build");
      expect(getPanePromptTail("pane-1")).toBe("deploy the staging build");
      expect(getPanePromptCount("pane-1")).toBe(1);
    });

    it("joins multiple prompts with newlines in submission order", () => {
      recordPanePrompt("pane-1", "first prompt");
      recordPanePrompt("pane-1", "second prompt");
      recordPanePrompt("pane-1", "third prompt");
      expect(getPanePromptTail("pane-1")).toBe(
        "first prompt\nsecond prompt\nthird prompt",
      );
      expect(getPanePromptCount("pane-1")).toBe(3);
    });

    it("returns the last N prompts when a limit is given", () => {
      recordPanePrompt("pane-1", "alpha");
      recordPanePrompt("pane-1", "bravo");
      recordPanePrompt("pane-1", "charlie");
      expect(getPanePromptTail("pane-1", 2)).toBe("bravo\ncharlie");
    });

    it("evicts oldest prompts when the per-pane cap is exceeded", () => {
      for (let i = 0; i < 12; i += 1) {
        recordPanePrompt("pane-1", `prompt-${i}`);
      }
      const tail = getPanePromptTail("pane-1");
      const lines = tail.split("\n");
      expect(lines).toHaveLength(8);
      expect(lines[0]).toBe("prompt-4");
      expect(lines[7]).toBe("prompt-11");
    });

    it("trims surrounding whitespace per prompt", () => {
      recordPanePrompt("pane-1", "   padded prompt   ");
      expect(getPanePromptTail("pane-1")).toBe("padded prompt");
    });

    it("skips empty or single-character submissions", () => {
      recordPanePrompt("pane-1", "");
      recordPanePrompt("pane-1", "  ");
      recordPanePrompt("pane-1", "x");
      expect(getPanePromptCount("pane-1")).toBe(0);
      expect(getPanePromptTail("pane-1")).toBe("");
    });

    it("strips ANSI escape sequences and control chars", () => {
      recordPanePrompt("pane-1", "[31mrun tests[0m");
      expect(getPanePromptTail("pane-1")).toBe("run tests");
    });

    it("caps overly long prompts to 200 characters", () => {
      recordPanePrompt("pane-1", "x".repeat(500));
      expect(getPanePromptTail("pane-1")).toHaveLength(200);
    });

    it("isolates prompts per pane", () => {
      recordPanePrompt("pane-a", "alpha");
      recordPanePrompt("pane-b", "bravo");
      expect(getPanePromptTail("pane-a")).toBe("alpha");
      expect(getPanePromptTail("pane-b")).toBe("bravo");
    });
  });

  describe("seedPanePrompt", () => {
    it("seeds an initial prompt that counts toward the buffer", () => {
      seedPanePrompt("pane-1", "claude --resume task-42");
      expect(getPanePromptTail("pane-1")).toBe("claude --resume task-42");
      expect(getPanePromptCount("pane-1")).toBe(1);
    });
  });

  describe("clearPanePrompt", () => {
    it("removes all prompts for the given pane", () => {
      recordPanePrompt("pane-1", "alpha");
      recordPanePrompt("pane-1", "bravo");
      clearPanePrompt("pane-1");
      expect(getPanePromptTail("pane-1")).toBe("");
      expect(getPanePromptCount("pane-1")).toBe(0);
    });

    it("does not affect other panes", () => {
      recordPanePrompt("pane-1", "alpha");
      recordPanePrompt("pane-2", "bravo");
      clearPanePrompt("pane-1");
      expect(getPanePromptTail("pane-2")).toBe("bravo");
    });
  });

  describe("subscribePanePromptBuffer", () => {
    it("captures submitted terminal:input events with promptText", () => {
      const bus = createCellBus();
      const unsubscribe = subscribePanePromptBuffer(bus);

      bus.emit("terminal:input", {
        paneId: "pane-1",
        workspaceId: "ws-1",
        data: "ls\r",
        ...DEFAULT_TERMINAL_INPUT_METADATA,
        origin: "human",
        submitted: true,
        promptText: "ls",
      });

      expect(getPanePromptTail("pane-1")).toBe("ls");
      unsubscribe();
    });

    it("ignores terminal:input events that did not submit", () => {
      const bus = createCellBus();
      const unsubscribe = subscribePanePromptBuffer(bus);

      bus.emit("terminal:input", {
        paneId: "pane-1",
        workspaceId: "ws-1",
        data: "l",
        ...DEFAULT_TERMINAL_INPUT_METADATA,
        origin: "human",
        submitted: false,
      });

      expect(getPanePromptCount("pane-1")).toBe(0);
      unsubscribe();
    });

    it("ignores submitted events without promptText (control keys)", () => {
      const bus = createCellBus();
      const unsubscribe = subscribePanePromptBuffer(bus);

      bus.emit("terminal:input", {
        paneId: "pane-1",
        workspaceId: "ws-1",
        data: "\r",
        ...DEFAULT_TERMINAL_INPUT_METADATA,
        origin: "human",
        submitted: true,
        promptText: "",
      });

      expect(getPanePromptCount("pane-1")).toBe(0);
      unsubscribe();
    });

    it("captures bridge:input events as user prompts", () => {
      const bus = createCellBus();
      const unsubscribe = subscribePanePromptBuffer(bus);

      bus.emit("bridge:input", {
        paneId: "pane-1",
        workspaceId: "ws-1",
        prompt: "analyze this repo",
      });

      expect(getPanePromptTail("pane-1")).toBe("analyze this repo");
      unsubscribe();
    });

    it("stops capturing after unsubscribe", () => {
      const bus = createCellBus();
      const unsubscribe = subscribePanePromptBuffer(bus);
      unsubscribe();

      bus.emit("bridge:input", {
        paneId: "pane-1",
        workspaceId: "ws-1",
        prompt: "should not be captured",
      });

      expect(getPanePromptCount("pane-1")).toBe(0);
    });

    it("clears buffered prompts when terminal:exited fires", () => {
      const bus = createCellBus();
      const unsubscribe = subscribePanePromptBuffer(bus);

      recordPanePrompt("pane-1", "deploy");
      bus.emit("terminal:exited", { paneId: "pane-1", workspaceId: "ws-1" });

      expect(getPanePromptCount("pane-1")).toBe(0);
      unsubscribe();
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GridCell } from "@/modules/codespace/components/types";
import { createCellBus } from "@/modules/codespace/services/bridge/cell-event-bus";
import { deriveFleet } from "@/modules/codespace/services/bridge/fleet-derivation";
import { encodeTerminalTextSubmission } from "@/modules/codespace/services/terminal-submit";
import {
  clearTerminalSessionRegistryForTests,
  createTerminalSession,
  getAllTerminalSessions,
  tapTerminalOutput,
  writeTerminalSession,
} from "@/modules/codespace/services/terminal-session-registry";
import {
  createLegacyTerminalSessionAdapter,
  installTerminalV2LegacySessionAdapter,
  TerminalV2SessionManager,
  type TerminalV2SessionController,
} from "../../index";

function terminalCell(id: string): GridCell {
  return {
    id,
    type: "terminal",
    cwd: "/repo",
    agentCommand: "claude",
  } as GridCell;
}

function createController(): TerminalV2SessionController & {
  emitOutput(data: string): void;
  writes: string[];
} {
  let onOutput: ((data: string) => void) | null = null;
  const writes: string[] = [];

  return {
    async connect(_cwd, _cols, _rows, nextOnOutput) {
      onOutput = nextOnOutput;
    },
    write(data) {
      writes.push(data);
    },
    resize: vi.fn(),
    abort: vi.fn(),
    getSessionId: () => "v2-session-bridge",
    emitOutput(data) {
      onOutput?.(data);
    },
    writes,
  };
}

describe("Terminal V2 Bridge dispatch/read-output parity", () => {
  beforeEach(() => {
    clearTerminalSessionRegistryForTests();
  });

  it("keeps V2-owned panes targetable by fleet session id, pane dispatch, and output reads", async () => {
    const controller = createController();
    const manager = new TerminalV2SessionManager({ controllerFactory: () => controller });
    const adapter = createLegacyTerminalSessionAdapter(manager);
    const uninstall = installTerminalV2LegacySessionAdapter(adapter);
    const outputTail: string[] = [];
    const untap = tapTerminalOutput("v2-pane", (chunk) => outputTail.push(chunk));

    await createTerminalSession({
      paneId: "v2-pane",
      workspaceId: "workspace-1",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
    }).connectPromise;

    const fleet = deriveFleet([terminalCell("v2-pane")], getAllTerminalSessions(), "workspace-1");
    writeTerminalSession("v2-pane", "run tests\r");
    controller.emitOutput("tests passed\n");

    expect(fleet).toEqual([
      expect.objectContaining({
        paneId: "v2-pane",
        workspaceId: "workspace-1",
        provider: "claude",
        status: "live",
        isAlive: true,
        sessionId: "v2-session-bridge",
      }),
    ]);
    expect(controller.writes).toEqual(["run tests\r"]);
    expect(outputTail.join("")).toBe("tests passed\n");

    untap();
    uninstall();
  });

  it("preserves Bridge dispatch metadata and writes once through the V2 adapter", async () => {
    const controller = createController();
    const manager = new TerminalV2SessionManager({ controllerFactory: () => controller });
    const adapter = createLegacyTerminalSessionAdapter(manager);
    const bus = createCellBus();
    const inputEvents: unknown[] = [];
    const detachBus = adapter.attachCellBus(bus);
    bus.on("terminal:input", (event) => inputEvents.push(event));
    const uninstall = installTerminalV2LegacySessionAdapter(adapter);

    await createTerminalSession({
      paneId: "v2-pane",
      workspaceId: "workspace-1",
      cwd: "/repo",
      cols: 80,
      rows: 24,
      onOutput: vi.fn(),
    }).connectPromise;

    writeTerminalSession("v2-pane", encodeTerminalTextSubmission("echo bridge"), {
      origin: "bridge",
      intent: "conversation-prompt",
      submitted: true,
      promptText: "echo bridge",
    });

    expect(controller.writes).toEqual(["echo bridge\r"]);
    expect(inputEvents).toEqual([
      expect.objectContaining({
        paneId: "v2-pane",
        workspaceId: "workspace-1",
        data: "echo bridge\r",
        origin: "bridge",
        intent: "conversation-prompt",
        submitted: true,
        promptText: "echo bridge",
      }),
    ]);

    detachBus();
    uninstall();
  });
});

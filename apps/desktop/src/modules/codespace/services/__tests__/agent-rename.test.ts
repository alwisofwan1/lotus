import { describe, expect, it } from "vitest";
import type { GridCell } from "@/modules/codespace/components/types";
import { renameAgentCell } from "../agent-rename";

const cells: GridCell[] = [
  { id: "a", cwd: "/r", type: "terminal", agentName: "Nara", agentCommand: "claude", legacyAgentAddresses: ["claude-1"] },
  { id: "b", cwd: "/r", type: "terminal", agentName: "Bima", agentCommand: "claude" },
];

describe("renameAgentCell", () => {
  it("changes the handle and keeps no alias for the old name", () => {
    const result = renameAgentCell(cells, "a", "  Kirana ");
    expect(result && "cells" in result ? result.cells[0] : null).toMatchObject({ agentName: "Kirana", legacyAgentAddresses: ["claude-1"] });
  });

  it("refuses a name another pane has, in any case, and a bad name", () => {
    expect(renameAgentCell(cells, "a", "bima")).toEqual({ error: "duplicate" });
    expect(renameAgentCell(cells, "a", "Bad!")).toEqual({ error: "invalid-char" });
    expect(renameAgentCell(cells, "a", " ")).toEqual({ error: "empty" });
  });

  it("does nothing for the same name or a pane that is not a terminal", () => {
    expect(renameAgentCell(cells, "a", "Nara")).toBeNull();
    expect(renameAgentCell(cells, "missing", "Kirana")).toBeNull();
  });
});

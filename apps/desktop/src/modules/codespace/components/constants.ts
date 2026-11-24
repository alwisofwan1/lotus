import type { LayoutTemplate, AgentType } from "./types";
import { PICKER_AGENT_IDS, resolve } from "@/modules/codespace/services/bridge/agent-registry";

/** Calculate optimal rows×cols for a given cell count. */
export function optimalGrid(cellCount: number): { rows: number; cols: number } {
  if (cellCount <= 0) return { rows: 1, cols: 1 };
  const tpl = LAYOUT_TEMPLATES.find(t => t.sessions >= cellCount);
  if (tpl) return { rows: tpl.rows, cols: tpl.cols };
  // Fallback for counts beyond templates: square-ish grid
  const cols = Math.ceil(Math.sqrt(cellCount));
  const rows = Math.ceil(cellCount / cols);
  return { rows, cols };
}

export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  { id: "single",  sessions: 1,  rows: 1, cols: 1, label: "Single" },
  { id: "2",       sessions: 2,  rows: 1, cols: 2, label: "2 Sessions" },
  { id: "4",       sessions: 4,  rows: 2, cols: 2, label: "4 Sessions" },
  { id: "6",       sessions: 6,  rows: 2, cols: 3, label: "6 Sessions" },
  { id: "8",       sessions: 8,  rows: 2, cols: 4, label: "8 Sessions" },
  { id: "10",      sessions: 10, rows: 2, cols: 5, label: "10 Sessions" },
  { id: "12",      sessions: 12, rows: 3, cols: 4, label: "12 Sessions" },
  { id: "14",      sessions: 14, rows: 2, cols: 7, label: "14 Sessions" },
  { id: "16",      sessions: 16, rows: 4, cols: 4, label: "16 Sessions" },
];

/** The New workspace's agent chips. Names, commands and order come from the agent registry. */
export const AGENT_TYPES: AgentType[] = PICKER_AGENT_IDS.map((id) => {
  const spec = resolve(id);
  const command = spec.command.join(" ");
  return { id, name: spec.displayName, command, description: command };
});

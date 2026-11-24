import { describe, expect, it } from "vitest";
import { workspaceInFolder } from "../delegation-target";

describe("workspaceInFolder", () => {
  const projects = [{ id: "w2" }, { id: "flow" }];
  const folders: Record<string, string> = { w2: "/x/codespace-demo", flow: "/x/flow-trader/" };

  it("picks the workspace whose folder is the board's", () => {
    expect(workspaceInFolder(projects, "/x/flow-trader", (id) => folders[id])).toBe("flow");
  });

  it("is null when no workspace is in that folder, or there is no folder", () => {
    expect(workspaceInFolder(projects, "/x/terax-ai", (id) => folders[id])).toBeNull();
    expect(workspaceInFolder(projects, null, (id) => folders[id])).toBeNull();
  });
});

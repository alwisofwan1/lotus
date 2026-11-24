import { describe, expect, it } from "vitest";
import { checkAgentRename, pickAgentName, type NamedThread } from "../agent-handle";

const threads: NamedThread[] = [
  { id: "a", cwd: "/r", archived: false, agentName: "Nara" },
  { id: "b", cwd: "/r", archived: false, agentName: "Bima" },
  { id: "c", cwd: "/r", archived: true, agentName: "Sena" },
  { id: "d", cwd: "/other", archived: false, agentName: "Bayu" },
  { id: "e", cwd: "/r", archived: false },
];

describe("chat Agent Handle", () => {
  it("picks a name no open chat of the folder uses; archived and other folders do not count", () => {
    expect(pickAgentName(threads, threads[4], ["Nara", "Bima", "Sena"])).toBe("Sena");
    expect(pickAgentName(threads, threads[4], ["Bima", "Bayu"])).toBe("Bayu");
  });

  it("checks a rename against the folder's open chats", () => {
    expect(checkAgentRename(threads, threads[0], "bima")).toEqual({ error: "duplicate" });
    expect(checkAgentRename(threads, threads[0], " Sena ")).toEqual({ name: "Sena" });
    expect(checkAgentRename(threads, threads[0], "Bad!")).toEqual({ error: "invalid-char" });
    expect(checkAgentRename(threads, threads[0], "Nara")).toBeNull();
  });
});

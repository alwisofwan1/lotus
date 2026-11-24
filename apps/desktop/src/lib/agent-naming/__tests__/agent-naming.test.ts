import { afterEach, describe, expect, it } from "vitest";
import {
  addPoolNames,
  replacePoolName,
  currentNamePool,
  deleteCustomPool,
  saveCustomPool,
  getAgentNamingSettings,
  resetAgentNamingStoreForTests,
  setActiveNamePool,
  setAgentNamingSettings,
} from "..";
import { ID_AGENT_NAME_POOL, JA_AGENT_NAME_POOL, resolveNamePool } from "@/lib/agent-catalog/name-pool";

const KEY = "agent-naming-v1";
const LEGACY = "canvas-behavior-settings-v1";
const wayang = { id: "c1", label: "Wayang", names: ["Arjuna", "Bima", "Srikandi", "Gatot", "Semar"] };

afterEach(() => {
  localStorage.clear();
  resetAgentNamingStoreForTests();
});

describe("agent naming store", () => {
  it("defaults to the device language", () => {
    expect(getAgentNamingSettings().active).toBe("auto");
    expect(currentNamePool()).toBe(resolveNamePool(navigator.language));
  });

  it("carries the old Canvas 'Naming language' over once, and writes the new key", () => {
    localStorage.setItem(LEGACY, JSON.stringify({ agentNameLocale: "id", tidyMode: "open" }));
    expect(currentNamePool()).toBe(ID_AGENT_NAME_POOL);
    expect(JSON.parse(localStorage.getItem(KEY)!).active).toBe("id");
  });

  it("the new key wins over the legacy one", () => {
    localStorage.setItem(LEGACY, JSON.stringify({ agentNameLocale: "id" }));
    localStorage.setItem(KEY, JSON.stringify({ active: "ja", customPools: [] }));
    expect(currentNamePool()).toBe(JA_AGENT_NAME_POOL);
  });

  it("draws from the active custom pool, and survives a reload", () => {
    setAgentNamingSettings({ active: "c1", customPools: [wayang] });
    resetAgentNamingStoreForTests();
    expect(currentNamePool()).toEqual(wayang.names);
  });

  it("falls back to auto when the active pool no longer exists, or the store is junk", () => {
    setAgentNamingSettings({ active: "c1", customPools: [wayang] });
    setAgentNamingSettings({ ...getAgentNamingSettings(), customPools: [] });
    expect(getAgentNamingSettings().active).toBe("auto");

    resetAgentNamingStoreForTests();
    localStorage.setItem(KEY, "{not json");
    localStorage.setItem(LEGACY, "{also not json");
    expect(getAgentNamingSettings()).toEqual({ active: "auto", customPools: [] });
  });

  it("saveCustomPool adds then replaces; deleting the active pool falls back to auto", () => {
    saveCustomPool(wayang);
    saveCustomPool({ ...wayang, label: "Wayang 2" });
    expect(getAgentNamingSettings().customPools).toEqual([{ ...wayang, label: "Wayang 2" }]);
    setActiveNamePool("c1");
    deleteCustomPool("c1");
    expect(getAgentNamingSettings()).toEqual({ active: "auto", customPools: [] });
  });

  it("addPoolNames splits a paste, drops duplicates quietly, reports a bad name", () => {
    expect(addPoolNames(["Arjuna"], "Bima, arjuna\nSrikandi\n\n")).toEqual({
      names: ["Arjuna", "Bima", "Srikandi"],
      rejected: null,
    });
    expect(addPoolNames([], "Semar, Bad!Name, Gatot")).toEqual({
      names: ["Semar", "Gatot"],
      rejected: { name: "Bad!Name", reason: "invalid-char" },
    });
    expect(addPoolNames([], "x".repeat(33)).rejected?.reason).toBe("too-long");
  });

  it("replacePoolName edits in place; empty removes; bad or duplicate keeps the old name", () => {
    const names = ["Daffa Alberta", "Mas Ali"];
    expect(replacePoolName(names, 0, " Daffa ")).toEqual({ names: ["Daffa", "Mas Ali"], rejected: null });
    expect(replacePoolName(names, 0, "")).toEqual({ names: ["Mas Ali"], rejected: null });
    expect(replacePoolName(names, 0, "mas ali")).toEqual({ names, rejected: null });
    expect(replacePoolName(names, 0, "Bad!")).toEqual({ names, rejected: { name: "Bad!", reason: "invalid-char" } });
  });

  it("a pool in use that drops under 5 names stays picked, draws from Auto, and comes back when full", () => {
    saveCustomPool(wayang);
    setActiveNamePool("c1");
    saveCustomPool({ ...wayang, names: wayang.names.slice(0, 4) });
    expect(getAgentNamingSettings().active).toBe("c1");
    expect(currentNamePool()).toBe(resolveNamePool(navigator.language));
    saveCustomPool({ ...wayang, names: [...wayang.names.slice(0, 4), "Petruk"] });
    expect(currentNamePool()).toEqual([...wayang.names.slice(0, 4), "Petruk"]);
  });

  it("setActiveNamePool switches the pool", () => {
    setActiveNamePool("ja");
    expect(currentNamePool()).toBe(JA_AGENT_NAME_POOL);
  });
});

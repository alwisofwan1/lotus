import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { getAgentNamingSettings, resetAgentNamingStoreForTests, saveCustomPool } from "@/lib/agent-naming";
import { AgentNamesSection } from "../sections/AgentNamesSection";

const team = { id: "c1", label: "Orbit Team", names: ["Daffa Alberta", "Daffa Alfandy", "Aditiya P", "Mas Ali", "Sam"] };

beforeEach(() => {
  localStorage.clear();
  resetAgentNamingStoreForTests();
});

describe("AgentNamesSection", () => {
  it("the circle picks the pool", () => {
    render(<AgentNamesSection />);
    fireEvent.click(screen.getByRole("radio", { name: "Use Bahasa Indonesia" }));
    expect(getAgentNamingSettings().active).toBe("id");
    expect(screen.getByRole("radio", { name: "Use Bahasa Indonesia" }).getAttribute("aria-checked")).toBe("true");
  });

  it("a name changes in place and saves on its own", () => {
    saveCustomPool(team);
    render(<AgentNamesSection />);
    fireEvent.click(screen.getByRole("button", { name: "Open Orbit Team" }));
    fireEvent.click(screen.getByRole("button", { name: "Daffa Alberta" }));
    const field = screen.getByRole("textbox", { name: "Change Daffa Alberta" });
    fireEvent.change(field, { target: { value: "Daffa" } });
    fireEvent.blur(field);
    expect(getAgentNamingSettings().customPools[0].names[0]).toBe("Daffa");

    fireEvent.click(screen.getByRole("button", { name: "Mas Ali" }));
    const bad = screen.getByRole("textbox", { name: "Change Mas Ali" });
    fireEvent.change(bad, { target: { value: "Bad!" } });
    fireEvent.blur(bad);
    expect(screen.getByRole("alert").textContent).toContain("Bad!");
    expect(getAgentNamingSettings().customPools[0].names[3]).toBe("Mas Ali");
  });

  it("a new pool can be used only after 5 names; a paste adds many", () => {
    render(<AgentNamesSection />);
    fireEvent.click(screen.getByRole("button", { name: /New pool/ }));
    const radio = screen.getByRole("radio", { name: "Use New pool" }) as HTMLButtonElement;
    expect(radio.disabled).toBe(true);
    fireEvent.paste(screen.getByRole("textbox", { name: "Add a name" }), {
      clipboardData: { getData: () => "Arjuna\nBima, Srikandi, Gatot\nSemar" },
    });
    expect(radio.disabled).toBe(false);
    fireEvent.click(radio);
    expect(getAgentNamingSettings().active).toBe(getAgentNamingSettings().customPools[0].id);
  });

  it("removing a name animates out, then saves; the pool in use under 5 keeps its radio", async () => {
    saveCustomPool(team);
    render(<AgentNamesSection />);
    fireEvent.click(screen.getByRole("radio", { name: "Use Orbit Team" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Orbit Team" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Sam" }));
    await waitFor(() => expect(getAgentNamingSettings().customPools[0].names).not.toContain("Sam"));
    expect(getAgentNamingSettings().active).toBe("c1");
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("4");
    expect(screen.getByText(/Until then, new agents get Auto names/)).toBeTruthy();
  });

  it("Copy and edit makes an editable copy of a built-in pool", () => {
    render(<AgentNamesSection />);
    fireEvent.click(screen.getByRole("button", { name: "Open Bahasa Indonesia" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy and edit" }));
    expect(getAgentNamingSettings().customPools[0]).toMatchObject({ label: "Bahasa Indonesia (copy)" });
    expect(screen.getByRole("textbox", { name: "Add a name" })).toBeTruthy();
  });

  it("deleting takes two clicks, and the pool in use falls back to Auto", () => {
    saveCustomPool(team);
    render(<AgentNamesSection />);
    fireEvent.click(screen.getByRole("radio", { name: "Use Orbit Team" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Orbit Team" }));
    expect(getAgentNamingSettings().customPools).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Delete pool?" }));
    expect(getAgentNamingSettings()).toEqual({ active: "auto", customPools: [] });
  });
});

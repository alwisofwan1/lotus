import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { TasksNavPanel, type TasksNavProject } from "@/modules/tasks/components/TasksNavPanel";
import { LOTUS_VOCABULARY } from "@/modules/tasks/services/task-vocabulary";
import { VAULT_VOCABULARY } from "@/modules/tasks/services/vault-vocabulary";
import { VAULT_CAPABILITIES } from "@/modules/tasks/services/vault-mapping";

const workspace: TasksNavProject = {
  id: "w1", name: "lotus", prefix: "LOT", vocabulary: LOTUS_VOCABULARY, taskCount: 6,
};
const vault: TasksNavProject = {
  id: "vault", name: "orbit-vault", prefix: "", vocabulary: VAULT_VOCABULARY,
  capabilities: VAULT_CAPABILITIES, taskCount: 82,
  source: { kind: "obsidian", syncLine: "Obsidian · watching folder" },
};

function renderNav(projects: TasksNavProject[], vaultPath = "") {
  const { container } = render(
    <TasksNavPanel
      projects={projects}
      vaultPath={vaultPath}
      onConnectVault={vi.fn()}
      onDisconnectVault={vi.fn()}
      onAddSource={vi.fn()}
      totalCount={0}
      activeCount={0}
      selection={null}
      onSelect={vi.fn()}
      presets={[]}
      onEditPreset={vi.fn()}
      onNewPreset={vi.fn()}
    />,
  );
  return container;
}

describe("the tracker nav's ticket sources", () => {
  it("with no source, offers to add one and shows no trace of Obsidian", () => {
    const container = renderNav([workspace]);

    expect(screen.getByText("Ticket sources")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Add ticket source/ })).toBeTruthy();
    // A person who never uses Obsidian must not be shown its name or its mark.
    expect(container.textContent).not.toMatch(/obsidian/i);
    expect(container.querySelector('[data-source-kind="obsidian"]')).toBeNull();
  });

  it("lists a source under Ticket sources, not under Projects, with its mark and its sync line", () => {
    const container = renderNav([workspace, vault], "/Users/me/orbit-vault");

    const row = screen.getByRole("button", { name: /orbit-vault/ });
    expect(within(row).getByText("Obsidian · watching folder")).toBeTruthy();
    expect(within(row).getByText("82")).toBeTruthy();
    expect(row.querySelector('[data-source-kind="obsidian"]')).not.toBeNull();

    // The source row comes after the Ticket sources heading; the workspace before it.
    const labels = [...container.querySelectorAll(".tk-nav-section, .tk-nav-item")].map((node) => node.textContent ?? "");
    const sourcesAt = labels.indexOf("Ticket sources");
    expect(labels.findIndex((text) => text.startsWith("lotus"))).toBeLessThan(sourcesAt);
    expect(labels.findIndex((text) => text.startsWith("orbit-vault"))).toBeGreaterThan(sourcesAt);
  });
});

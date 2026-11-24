import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FactoryAgentDefinition, FactoryDefinition, FactoryDefinitionView, FactoryRole } from "@/lib/tauri/graph-run";
import { FactoryAgentsView } from "@/modules/factory/components/FactoryAgentsView";
import type { FactoryAgentsSource } from "@/modules/factory/services/factory-agents";

const ROLES: FactoryRole[] = ["triage", "spec", "implement", "review", "handoff"];

function definition(over: Partial<Record<FactoryRole, Partial<FactoryAgentDefinition>>> = {}): FactoryDefinition {
  return {
    gate: "bun run test",
    private: false,
    capUsd: 5,
    skills: ["domain"],
    mcp: [],
    skipBrainstorm: [],
    agents: ROLES.map((role) => ({
      role,
      preset: null,
      model: null,
      sameModel: false,
      skills: [],
      mcp: [],
      access: role === "implement" ? "full" : "read-only",
      timeoutMinutes: null,
      maxQuestions: null,
      prompt: `built-in ${role}`,
      source: null,
      ...over[role],
    })),
  };
}

function viewOf(def: FactoryDefinition | null, unpushed: FactoryDefinitionView["unpushed"] = [], error: string | null = null): FactoryDefinitionView {
  return {
    base: "main",
    baseFromFile: false,
    origin: { definition: def, error: null },
    local: { definition: def, error },
    unpushed,
    builtInPrompts: { triage: "built-in triage", spec: "built-in spec", implement: "built-in implement", review: "built-in review", handoff: "built-in handoff" },
    notes: [],
    private: null,
  };
}

function source(over: Partial<FactoryAgentsSource> = {}): FactoryAgentsSource {
  const def = definition({ spec: { skills: ["tdd", "ghost"], source: ".lotus/factory/agents/spec.md" } });
  return {
    repos: [{ id: "r1", repo: "o/r" }],
    findCheckout: vi.fn(async () => "/c"),
    view: vi.fn(async () => viewOf(def, [{ path: ".lotus/factory/agents/spec.md", state: "added" }])),
    catalog: vi.fn(async () => ({
      skills: [
        { id: "tdd", source: "user" as const, description: "Red, green" },
        { id: "domain", source: "repo" as const, description: null },
        { id: "grill", source: "user" as const, description: "Ask questions" },
      ],
      mcp: [{ name: "context7", scope: "user" as const, transport: "stdio", target: "npx" }],
      notes: [],
    })),
    presets: vi.fn(async () => [{ id: "p1", name: "Opus" }]),
    saveAgent: vi.fn(async () => def),
    saveShared: vi.fn(async () => def),
    setupPrivate: vi.fn(async () => ({ ...def, private: true })),
    suggestChecks: vi.fn(async () => [{ label: "Tests", command: "npm run test", evidence: "Detected from package.json · npm. Not verified." }]),
    saveGate: vi.fn(async () => def),
    removePrivate: vi.fn(async () => "recovery-id"),
    restorePrivate: vi.fn(async () => ({ ...def, private: true })),
    ...over,
  };
}

const openTab = (name: string) => fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${name}`) }));
// A role's prompt stays folded while it is the built-in one.
const editPrompt = (pane: HTMLElement) => {
  const open = within(pane).queryByRole("button", { name: "Edit prompt" });
  if (open) fireEvent.click(open);
};

describe("FactoryAgentsView", () => {
  it("reports catalog errors and refreshes integrations without discarding an agent draft", async () => {
    const catalog = vi.fn<FactoryAgentsSource["catalog"]>()
      .mockRejectedValueOnce(new Error("Discovery unavailable"))
      .mockResolvedValue({ skills: [{ id: "new:tdd", source: "plugin", description: "Test first" }], mcp: [], notes: ["A plugin is disabled"] });
    render(<FactoryAgentsView source={source({ catalog })} />);
    fireEvent.click(await screen.findByRole("button", { name: /^spec/ }));
    editPrompt(screen.getByRole("complementary", { name: "Agent settings" }));
    const prompt = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(prompt, { target: { value: "Keep my draft" } });
    openTab("Integrations");
    expect(await screen.findByText(/Could not load integrations: Discovery unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh integrations" }));
    expect(await screen.findByText("A plugin is disabled")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Prompt" }) as HTMLInputElement).value).toBe("Keep my draft");
    fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
    expect(screen.getByRole("menuitemcheckbox", { name: /new:tdd/ })).toBeTruthy();
    expect(catalog).toHaveBeenCalledTimes(2);
  });

  it("separates actionable warnings from collapsed integration information", async () => {
    const catalog = vi.fn(async () => ({
      skills: [], mcp: [],
      notes: ["Matt Pocock is enabled but has no applicable installation. Install for this project or user scope."],
      notices: ["Context7 is disabled", "Commands and hooks are not imported"],
    }));
    render(<FactoryAgentsView source={source({ catalog })} />);
    await screen.findByRole("button", { name: /^spec/ });
    openTab("Integrations");
    expect(await screen.findByText("1 needs a decision")).toBeTruthy();
    const row = screen.getByText(/Matt Pocock/).closest("li")!;
    // One sentence in the row; the runner's whole text opens under Details, and nothing offers to fix it.
    expect(within(row).queryByText(/Install for this project or user scope/)).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: /Details/ }));
    expect(within(row).getByText(/Install for this project or user scope/)).toBeTruthy();
    const info = screen.getByText("Integration information (2)").closest("details")!;
    expect(info.open).toBe(false);
    expect(within(info).getByText("Context7 is disabled")).toBeTruthy();
    expect(within(info).getByText("Commands and hooks are not imported")).toBeTruthy();
  });

  it("shows and searches exact plugin provenance without changing the saved skill id", async () => {
    const catalog = vi.fn(async () => ({
      skills: [{ id: "tools:tdd", source: "plugin" as const, description: "Test first", plugin: "tools@official-market" }],
      mcp: [{ name: "plugin-tools--docs", scope: "plugin" as const, transport: "stdio", target: "node", plugin: "tools@official-market" }],
      notes: [],
    }));
    const src = source({ catalog });
    render(<FactoryAgentsView source={src} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Shared by all roles/ }));
    const pane = screen.getByRole("complementary", { name: "Agent settings" });
    await waitFor(() => expect((within(pane).getByRole("button", { name: "Add skill" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(pane).getByRole("button", { name: "Add skill" }));
    const picker = within(pane).getByRole("dialog", { name: "Add skill" });
    fireEvent.change(within(picker).getByRole("textbox", { name: "Search skills" }), { target: { value: "official-market" } });
    const item = within(picker).getByRole("menuitemcheckbox", { name: /tools:tdd/ });
    expect(within(item).getByText("Plugin: tools@official-market")).toBeTruthy();
    fireEvent.click(item);
    fireEvent.keyDown(picker, { key: "Escape" });
    expect(within(pane).getByText("tools:tdd")).toBeTruthy();
    fireEvent.click(within(pane).getByRole("button", { name: "Save to repo" }));
    await waitFor(() => expect(src.saveShared).toHaveBeenCalledWith("/c", ["domain", "tools:tdd"], []));
  });

  it("edits local checks, requires removal confirmation, preserves failures and supports Undo", async () => {
    const dir = "/state/factory-private/o/r";
    const make = (gate: string) => ({ ...viewOf({ ...definition(), gate, private: true }), private: { dir } });
    const empty = { ...viewOf(null, [], "no .lotus/factory.toml"), private: { dir } };
    const view = vi.fn<FactoryAgentsSource["view"]>().mockResolvedValueOnce(make("npm test"))
      .mockResolvedValueOnce(make("npm run typecheck")).mockResolvedValueOnce(empty).mockResolvedValue(make("npm run typecheck"));
    const removePrivate = vi.fn().mockRejectedValueOnce(new Error("Finish unfinished runs first")).mockResolvedValue("backup-id");
    const src = source({ view, removePrivate });
    render(<FactoryAgentsView source={src} />);
    await screen.findByRole("button", { name: /^spec/ });
    openTab("Checks");
    const input = await screen.findByLabelText("Gate command");
    fireEvent.change(input, { target: { value: "npm run typecheck" } });
    fireEvent.click(screen.getByRole("button", { name: "Save checks" }));
    await waitFor(() => expect(src.saveGate).toHaveBeenCalledWith("/c", "o/r", "npm run typecheck", true));
    await waitFor(() => expect(view).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Remove local factory" }));
    expect(removePrivate).not.toHaveBeenCalled();
    expect(screen.getByText(/does not delete repository code, plugins, worktrees, or run history/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove configuration" }));
    expect(await screen.findByText("Finish unfinished runs first")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove configuration" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove configuration" }));
    expect(await screen.findByRole("button", { name: "Undo removal" })).toBeTruthy();
    await waitFor(() => expect(view).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "Undo removal" }));
    await waitFor(() => expect(src.restorePrivate).toHaveBeenCalledWith("o/r", "backup-id"));
    await waitFor(() => expect(view).toHaveBeenCalledTimes(4));
  });

  it("automatically selects discovered checks and rescans without overwriting a custom command", async () => {
    const dir = "/state/factory-private/o/r";
    const suggestChecks = vi.fn<FactoryAgentsSource["suggestChecks"]>()
      .mockResolvedValueOnce([{ label: "Project checks", command: "npm run check", evidence: "package.json" }])
      .mockResolvedValue([{ label: "Tests", command: "npm run test", evidence: "package.json" }]);
    const src = source({ suggestChecks, view: vi.fn(async () => ({ ...viewOf(null, [], "no .lotus/factory.toml"), private: { dir } })) });
    render(<FactoryAgentsView source={src} />);
    const input = await screen.findByLabelText("Gate command");
    await waitFor(() => expect((input as HTMLInputElement).value).toBe("npm run check"));
    expect(screen.getByText("Recommended")).toBeTruthy();
    expect(src.setupPrivate).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "my-checks" } });
    fireEvent.click(screen.getByRole("button", { name: "Scan repository" }));
    expect(await screen.findByText("Tests")).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("my-checks");
  });

  it("does not replace typing while automatic scan is pending", async () => {
    let resolve!: (v: Awaited<ReturnType<FactoryAgentsSource["suggestChecks"]>>) => void;
    const suggestChecks = vi.fn(() => new Promise<Awaited<ReturnType<FactoryAgentsSource["suggestChecks"]>>>((done) => { resolve = done; }));
    const src = source({ suggestChecks, view: vi.fn(async () => ({ ...viewOf(null, [], "no .lotus/factory.toml"), private: { dir: "/private" } })) });
    render(<FactoryAgentsView source={src} />);
    const input = await screen.findByLabelText("Gate command");
    fireEvent.change(input, { target: { value: "custom-first" } });
    resolve([{ label: "Tests", command: "npm run test", evidence: "package.json" }]);
    expect(await screen.findByText("Tests")).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("custom-first");
  });

  it("previews an unsaved private check draft without automatically saving or executing it", async () => {
    const preview = { id: "trial", repo: "o/r", checkout: "/c", base: "main", revision: "a".repeat(40), command: "custom-check", shell: true, worktree: "/state/trial", timeoutSeconds: 2400 };
    const checks = {
      preview: vi.fn(async () => preview),
      start: vi.fn(async () => ({ ...preview, status: "running" as const, exitCode: null, output: "", elapsedMs: 0, currentRevision: preview.revision, message: "Preparing" })),
      status: vi.fn(async () => null),
      cancel: vi.fn(async () => undefined),
    };
    const src = source({ checks, view: vi.fn(async () => ({ ...viewOf(null, [], "no .lotus/factory.toml"), private: { dir: "/private" } })) });
    render(<FactoryAgentsView source={src} />);
    fireEvent.change(await screen.findByLabelText("Gate command"), { target: { value: "custom-check" } });
    fireEvent.click(screen.getByRole("button", { name: "Try checks" }));
    expect(await screen.findByRole("button", { name: "Run checks now" })).toBeTruthy();
    expect(checks.preview).toHaveBeenCalledWith("/c", "o/r", "main", "custom-check");
    expect(checks.start).not.toHaveBeenCalled();
    expect(src.setupPrivate).not.toHaveBeenCalled();
    expect(src.saveGate).not.toHaveBeenCalled();
  });

  it("offers safe removal even when local configuration cannot be parsed", async () => {
    const src = source({ view: vi.fn(async () => ({ ...viewOf(null, [], "Invalid Factory configuration"), private: { dir: "/state/factory-private/o/r" } })) });
    render(<FactoryAgentsView source={src} />);
    expect(await screen.findByRole("button", { name: "Remove local factory" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save checks" })).toBeNull();
  });

  it("retains removal recovery after reopening Factory", async () => {
    window.localStorage.setItem("lotus:factory-recovery:o/r", "stored-backup-id");
    const dir = "/state/factory-private/o/r";
    const src = source({ view: vi.fn(async () => ({ ...viewOf(null, [], "no .lotus/factory.toml"), private: { dir } })) });
    render(<FactoryAgentsView source={src} />);
    fireEvent.click(await screen.findByRole("button", { name: "Undo removal" }));
    await waitFor(() => expect(src.restorePrivate).toHaveBeenCalledWith("o/r", "stored-backup-id"));
    expect(window.localStorage.getItem("lotus:factory-recovery:o/r")).toBeNull();
  });

  it("uses script-path guidance for repository checks and never offers local removal", async () => {
    render(<FactoryAgentsView source={source()} />);
    expect(await screen.findByLabelText("Gate script path")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove local factory" })).toBeNull();
    expect(screen.getByText(/script path, not a shell command/)).toBeTruthy();
  });

  it("shows loading until the catalog is available", async () => {
    let resolve!: (value: Awaited<ReturnType<FactoryAgentsSource["catalog"]>>) => void;
    const catalog = vi.fn(() => new Promise<Awaited<ReturnType<FactoryAgentsSource["catalog"]>>>((done) => { resolve = done; }));
    render(<FactoryAgentsView source={source({ catalog })} />);
    await screen.findByRole("button", { name: /^spec/ });
    openTab("Integrations");
    expect(await screen.findByRole("list", { name: "Loading integrations" })).toHaveAttribute("aria-busy", "true");
    resolve({ skills: [], mcp: [], notes: [] });
    expect(await screen.findByText("0 skills · 0 MCP servers discovered")).toBeTruthy();
  });

  it("lists the five roles in run order, with the unpushed badge", async () => {
    render(<FactoryAgentsView source={source()} />);
    const rows = await screen.findAllByRole("button", { name: /^(triage|spec|implement|review|handoff)/ });
    expect(rows.map((r) => r.textContent?.match(/^\d(triage|spec|implement|review|handoff)/)?.[1])).toEqual(ROLES);
    expect(screen.getByText("1 file not pushed")).toBeTruthy();
    expect(screen.getByTitle("PRs go into: main (the default branch)").textContent).toBe("PRs → main");
    expect(within(rows[1]).getByText("not pushed")).toBeTruthy();
    expect(within(rows[0]).getByText("no MCP")).toBeTruthy();
    expect(within(rows[2]).getByText("Full access")).toBeTruthy();
    expect(within(rows[3]).queryByText("Coming soon")).toBeNull();
    expect(within(rows[4]).getByText("Coming soon")).toBeTruthy();
    expect((rows[4] as HTMLButtonElement).disabled).toBe(true);
  });

  it("says when no workspace holds the repo", async () => {
    render(<FactoryAgentsView source={source({ findCheckout: vi.fn(async () => null) })} />);
    expect(await screen.findByText(/No open workspace holds a checkout of o\/r/)).toBeTruthy();
  });

  it("says how to start when the repo has no factory", async () => {
    const view = vi.fn(async () => viewOf(null, [], "no .lotus/factory.toml in /c"));
    render(<FactoryAgentsView source={source({ view })} />);
    expect(await screen.findByText(/This repo has no factory yet/)).toBeTruthy();
  });

  it("edits a role: marks a missing skill, adds one from the catalog, saves, then reads again", async () => {
    const src = source();
    render(<FactoryAgentsView source={src} />);
    fireEvent.click(await screen.findByRole("button", { name: /^spec/ }));
    const pane = await screen.findByRole("complementary", { name: "Agent settings" });
    await within(pane).findByText("not on this Mac");
    const save = within(pane).getByRole("button", { name: "Save to repo" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.click(within(pane).getByRole("button", { name: "Add skill" }));
    const picker = within(pane).getByRole("dialog", { name: "Add skill" });
    fireEvent.change(within(picker).getByRole("textbox", { name: "Search skills" }), { target: { value: "questions" } });
    fireEvent.click(within(picker).getByRole("menuitemcheckbox", { name: /grill/ }));
    fireEvent.keyDown(picker, { key: "Escape" });
    expect(within(pane).queryByRole("dialog")).toBeNull();
    // Esc closed the picker only, not the pane.
    expect(screen.getByRole("complementary", { name: "Agent settings" })).toBeTruthy();

    editPrompt(pane);
    fireEvent.change(within(pane).getByRole("textbox", { name: "Prompt" }), { target: { value: "Ask more." } });
    fireEvent.click(save);
    await waitFor(() => expect(src.saveAgent).toHaveBeenCalledTimes(1));
    expect(src.saveAgent).toHaveBeenCalledWith("/c", "spec", {
      preset: null,
      model: null,
      sameModel: false,
      skills: ["tdd", "ghost", "grill"],
      mcp: [],
      timeoutMinutes: null,
      maxQuestions: null,
      prompt: "Ask more.",
    });
    await waitFor(() => expect(src.view).toHaveBeenCalledTimes(2));
  });

  it("Use built-in sends a reset; a refused save shows why and keeps the draft", async () => {
    const saveAgent = vi.fn().mockRejectedValueOnce(new Error("the checkout is not writable")).mockResolvedValue(definition());
    render(<FactoryAgentsView source={source({ saveAgent })} />);
    fireEvent.click(await screen.findByRole("button", { name: /^spec/ }));
    const pane = await screen.findByRole("complementary", { name: "Agent settings" });
    const timeout = within(pane).getByRole("spinbutton", { name: /Timeout/ }) as HTMLInputElement;
    fireEvent.change(timeout, { target: { value: "45" } });
    fireEvent.blur(timeout);
    fireEvent.click(within(pane).getByRole("button", { name: "Save to repo" }));
    expect((await within(pane).findByRole("alert")).textContent).toContain("not writable");
    expect(timeout.value).toBe("45");

    fireEvent.click(within(pane).getByRole("button", { name: /Use built-in/ }));
    await waitFor(() => expect(saveAgent).toHaveBeenLastCalledWith("/c", "spec", null));
  });

  it("limits are steppers on the backend's bounds, and empty stays a real value", async () => {
    const saveAgent = vi.fn().mockResolvedValue(definition());
    render(<FactoryAgentsView source={source({ saveAgent })} />);
    fireEvent.click(await screen.findByRole("button", { name: /^spec/ }));
    const pane = await screen.findByRole("complementary", { name: "Agent settings" });
    const timeout = within(pane).getByRole("spinbutton", { name: /Timeout/ });
    const questions = within(pane).getByRole("spinbutton", { name: "Questions per round" });
    expect(timeout.getAttribute("aria-valuemax")).toBe("240");
    expect(timeout.getAttribute("aria-valuetext")).toBe("20 min · default");
    expect(questions.getAttribute("aria-valuemax")).toBe("50");
    expect(questions.getAttribute("aria-valuetext")).toBe("no cap");

    fireEvent.click(within(pane).getByRole("button", { name: /Increase Timeout/ }));
    fireEvent.change(questions, { target: { value: "99" } });
    fireEvent.blur(questions);
    fireEvent.click(within(pane).getByRole("button", { name: "Save to repo" }));
    await waitFor(() =>
      expect(saveAgent).toHaveBeenCalledWith("/c", "spec", expect.objectContaining({ timeoutMinutes: 20, maxQuestions: 50 })),
    );
  });

  it("offers a timeout only to the roles whose run reads it", async () => {
    render(<FactoryAgentsView source={source()} />);
    for (const [role, timed] of [["triage", true], ["review", true], ["implement", false], ["handoff", false]] as const) {
      fireEvent.click(await screen.findByRole("button", { name: new RegExp(`^${role}`) }));
      const pane = await screen.findByRole("complementary", { name: "Agent settings" });
      expect(within(pane).queryByRole("spinbutton", { name: /Timeout/ }) !== null, role).toBe(timed);
      expect(within(pane).queryByRole("spinbutton", { name: "Questions per round" }), role).toBeNull();
      if (!timed) expect(within(pane).queryByText("Limits"), role).toBeNull();
    }
  });

  it("rows count what the run gets and say when a name is missing; a role no run prepares keeps its file's count", async () => {
    render(<FactoryAgentsView source={source()} />);
    const rows = await screen.findAllByRole("button", { name: /^(triage|spec|implement|review|handoff)/ });
    expect(await within(rows[1]).findByText("3 skills · 1 missing")).toBeTruthy();
    expect(within(rows[0]).getByText("1 skill")).toBeTruthy();
    expect(within(rows[4]).getByText("0 skills")).toBeTruthy();
  });

  it("the pane draws the role's kit: shared quiet, own solid, a missing name red with the runner's refusal", async () => {
    render(<FactoryAgentsView source={source()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^spec/ }));
    const pane = await screen.findByRole("complementary", { name: "Agent settings" });
    const skills = within(pane).getByRole("list", { name: "Skills spec gets" });
    const refusal = await within(pane).findByText('the spec agent needs what this Mac no longer has: skill "ghost"');
    expect(refusal).toBeTruthy();
    expect(within(skills).getByText("domain").closest("li")?.getAttribute("data-kind")).toBe("shared");
    expect(within(skills).getByText("tdd").closest("li")?.getAttribute("data-kind")).toBe("own");
    expect(within(skills).getByText("ghost").closest("li")?.getAttribute("data-kind")).toBe("missing");

    fireEvent.click(within(pane).getByRole("button", { name: "Remove ghost" }));
    await waitFor(() => expect(within(pane).queryByText(/needs what this Mac no longer has/)).toBeNull());
  });

  it("triage says no MCP, and handoff cannot be opened because no run prepares it", async () => {
    render(<FactoryAgentsView source={source()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^triage/ }));
    const pane = await screen.findByRole("complementary", { name: "Agent settings" });
    expect(within(within(pane).getByRole("list", { name: "MCP servers triage gets" })).getByText("no MCP")).toBeTruthy();

    // Handoff is a dimmed card: no run prepares it, so there is nothing to edit.
    expect((screen.getByRole("button", { name: /^handoff/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("folds a long list into +N more that opens the picker", async () => {
    const many = Array.from({ length: 7 }, (_, i) => `s${i}`);
    render(<FactoryAgentsView source={source({ view: vi.fn(async () => viewOf(definition({ implement: { skills: many } }))) })} />);
    fireEvent.click(await screen.findByRole("button", { name: /^implement/ }));
    const pane = await screen.findByRole("complementary", { name: "Agent settings" });
    fireEvent.click(await within(pane).findByRole("button", { name: /3 more skills/ }));
    expect(within(pane).getByRole("dialog", { name: "Add skill" })).toBeTruthy();
  });

  it("review sets its own model and may allow the same one as implement (FI7)", async () => {
    const saveAgent = vi.fn().mockResolvedValue(definition());
    render(<FactoryAgentsView source={source({ saveAgent })} />);
    fireEvent.click(await screen.findByRole("button", { name: /^review/ }));
    const pane = await screen.findByRole("complementary", { name: "Agent settings" });
    expect(within(pane).getByText(/Off: Review runs only on another preset or model/)).toBeTruthy();
    // The custom name folds away until asked for.
    expect(within(pane).queryByRole("textbox", { name: "Model name" })).toBeNull();
    fireEvent.click(within(pane).getByRole("button", { name: /Custom model name/ }));
    fireEvent.change(within(pane).getByRole("textbox", { name: "Model name" }), { target: { value: "opus" } });
    fireEvent.click(within(pane).getByRole("switch", { name: /Allow the same model as Implement/ }));
    expect(within(pane).getByText(/On: Review runs even on the same model/)).toBeTruthy();
    fireEvent.click(within(pane).getByRole("button", { name: "Save to repo" }));
    await waitFor(() =>
      expect(saveAgent).toHaveBeenCalledWith("/c", "review", expect.objectContaining({ model: "opus", sameModel: true })),
    );
  });

  it("only review offers the same-model switch", async () => {
    render(<FactoryAgentsView source={source()} />);
    fireEvent.click(await screen.findByRole("button", { name: /^spec/ }));
    const pane = await screen.findByRole("complementary", { name: "Agent settings" });
    expect(within(pane).getByRole("button", { name: /Custom model name/ })).toBeTruthy();
    expect(within(pane).queryByRole("switch", { name: /Allow the same model/ })).toBeNull();
  });

  it("triage has no MCP field; the shared row saves skills and servers", async () => {
    const src = source();
    render(<FactoryAgentsView source={src} />);
    fireEvent.click(await screen.findByRole("button", { name: /^triage/ }));
    let pane = await screen.findByRole("complementary", { name: "Agent settings" });
    expect(within(pane).getByText(/Triage never gets an MCP server/)).toBeTruthy();
    expect(within(pane).queryByRole("button", { name: "Add server" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Shared by all roles/ }));
    pane = await screen.findByRole("complementary", { name: "Agent settings" });
    await waitFor(() => expect((within(pane).getByRole("button", { name: "Add server" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(pane).getByRole("button", { name: "Add server" }));
    fireEvent.click(within(pane).getByRole("menuitemcheckbox", { name: /context7/ }));
    fireEvent.click(within(pane).getByRole("button", { name: "Save to repo" }));
    await waitFor(() => expect(src.saveShared).toHaveBeenCalledWith("/c", ["domain"], ["context7"]));
  });
  it("a repo with no factory sets up a private one on this Mac, then edits it there", async () => {
    const dir = "/state/factory-private/o/r";
    const empty: FactoryDefinitionView = {
      ...viewOf(null, [], "no .lotus/factory.toml: a Factory Run needs the repo to declare its gate"),
      private: { dir },
    };
    const set = { ...viewOf({ ...definition(), gate: "npm test", private: true }), private: { dir } };
    const view = vi.fn<FactoryAgentsSource["view"]>().mockResolvedValueOnce(empty).mockResolvedValue(set);
    const src = source({ view, catalog: vi.fn(async () => ({ skills: [], mcp: [], notes: ["Plugin unavailable"] })) });
    render(<FactoryAgentsView source={src} />);
    const gate = await screen.findByLabelText("Gate command");
    expect(await screen.findByText("Tests")).toBeTruthy();
    expect(src.suggestChecks).toHaveBeenCalledWith("/c");
    expect(screen.queryByText("Saved on this Mac only")).toBeNull();
    expect(screen.queryByText(/PRs →/)).toBeNull();
    // Without a definition the setup comes first; the warning waits behind the Integrations tab.
    expect(screen.getByRole("tab", { name: /^Checks/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("region", { name: "Integrations" })).toBeNull();
    openTab("Integrations");
    expect(await screen.findByRole("region", { name: "Integrations" })).toBeTruthy();
    expect(screen.getByText("Plugin unavailable")).toBeTruthy();
    openTab("Checks");
    expect(view).toHaveBeenCalledWith("/c", "o/r");
    fireEvent.change(gate, { target: { value: " npm test " } });
    fireEvent.click(screen.getByRole("button", { name: "Set up private factory" }));
    await waitFor(() => expect(src.setupPrivate).toHaveBeenCalledWith("o/r", "npm test"));
    openTab("Pipeline");
    fireEvent.click(await screen.findByRole("button", { name: /^spec/ }));
    expect(screen.getByText("Saved on this Mac only").getAttribute("title")).toContain("Private to this Mac · not in the repo");
    expect(screen.getByTitle("PRs go into: main (the default branch)")).toBeTruthy();
    const pane = await screen.findByRole("complementary", { name: "Agent settings" });
    editPrompt(pane);
    fireEvent.change(within(pane).getByRole("textbox", { name: "Prompt" }), { target: { value: "Ask more." } });
    fireEvent.click(within(pane).getByRole("button", { name: "Save on this Mac" }));
    await waitFor(() => expect(src.saveAgent).toHaveBeenCalledWith(dir, "spec", expect.anything()));
  });
});

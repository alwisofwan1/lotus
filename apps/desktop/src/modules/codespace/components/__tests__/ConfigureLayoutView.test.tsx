import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings: Record<string, unknown> = {};
vi.mock("@/lib/tauri-api", () => ({
  getHomedir: vi.fn().mockResolvedValue("/Users/me"),
  listDirEntries: vi.fn().mockResolvedValue([]),
  getSettings: vi.fn(async () => structuredClone(settings)),
  saveSettings: vi.fn(async (next: Record<string, unknown>) => { Object.assign(settings, next); }),
  isTauri: () => false,
  detectInstalledClis: (...a: unknown[]) => detectInstalledClis(...a),
}));
const detectInstalledClis = vi.fn();

const sshProbeWorkspace = vi.fn();
vi.mock("@/lib/tauri/codespace-editor-ssh", () => ({ sshProbeWorkspace: (...a: unknown[]) => sshProbeWorkspace(...a) }));

import { ConfigureLayoutView } from "../ConfigureLayoutView";

const lotus = {
  id: "p1", name: "Lotus", templateId: "single", cwd: "/Users/me/Lotus",
  agentSlots: { claude: 1 }, createdAt: 1, updatedAt: 1,
};
type Saved = typeof lotus & { pinned?: boolean; lastOpenedAt?: number };
const saved = () => settings["terminal-presets"] as Saved[];

function setup(extra: { onOpenRemote?: () => void } = {}) {
  const onLaunch = vi.fn();
  const onCancel = vi.fn();
  render(<ConfigureLayoutView onCancel={onCancel} onLaunch={onLaunch} {...extra} />);
  return { onLaunch, onCancel };
}
const launchBtn = () => screen.getByRole("button", { name: /^Launch/ });

describe("ConfigureLayoutView", () => {
  beforeEach(() => {
    for (const k of Object.keys(settings)) delete settings[k];
    sshProbeWorkspace.mockReset().mockResolvedValue({ runners: [{ id: "claude" }] });
    detectInstalledClis.mockReset().mockResolvedValue([]);
    localStorage.clear();
  });

  it("launches shells only: one empty command per pane", async () => {
    const { onLaunch } = setup();
    await screen.findByDisplayValue("/Users/me");
    await userEvent.click(screen.getByRole("radio", { name: "2" }));
    await userEvent.click(launchBtn());
    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ id: "2" }), "/Users/me", ["", ""], undefined, undefined);
  });

  it("agent chips fill panes in order, − removes, and a full layout disables adding", async () => {
    const { onLaunch } = setup();
    await userEvent.click(await screen.findByRole("radio", { name: "2" }));
    await userEvent.click(screen.getByRole("button", { name: /Codex/ }));
    await userEvent.click(screen.getByRole("button", { name: /Claude/ }));
    expect(screen.getByRole("button", { name: "Remove Codex from pane 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Claude from pane 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Gemini/ })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Fewer Codex" }));
    expect(screen.getByRole("button", { name: "Remove Claude from pane 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Gemini/ })).toBeEnabled();

    await userEvent.click(launchBtn());
    expect(onLaunch.mock.calls[0][2]).toEqual([expect.stringContaining("claude"), ""]);
  });

  it("shrinking the layout drops agents that no longer fit", async () => {
    const { onLaunch } = setup();
    await userEvent.click(await screen.findByRole("radio", { name: "4" }));
    await userEvent.click(screen.getByRole("button", { name: /Claude/ }));
    for (let i = 0; i < 3; i++) await userEvent.click(screen.getByRole("button", { name: "More Claude" }));
    expect(screen.getByRole("button", { name: "More Claude" })).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: "2" }));
    await userEvent.click(launchBtn());
    const cmds = onLaunch.mock.calls[0][2] as string[];
    expect(cmds).toHaveLength(2);
    expect(cmds.every(c => c.includes("claude"))).toBe(true);
  });

  it("refuses to launch while the preset name is empty", async () => {
    const { onLaunch } = setup();
    await userEvent.click(await screen.findByRole("checkbox", { name: "Save as preset" }));
    await userEvent.click(launchBtn());
    expect(onLaunch).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Name the preset");
  });

  it("saves a new preset with its agents on launch", async () => {
    const { onLaunch } = setup();
    await userEvent.click(await screen.findByRole("button", { name: /Claude/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Save as preset" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Preset name" }), "Plain");
    await userEvent.click(launchBtn());
    await waitFor(() => expect(saved()).toEqual([
      expect.objectContaining({ name: "Plain", templateId: "single", agentSlots: { claude: 1 }, lastOpenedAt: expect.any(Number) }),
    ]));
    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ id: "single" }), "/Users/me", [expect.stringContaining("claude")], "Plain", undefined);
  });

  it("Esc closes the view, but not while typing in a field", async () => {
    const { onCancel } = setup();
    await userEvent.click(await screen.findByRole("checkbox", { name: "Save as preset" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Preset name" }), "x{Escape}");
    expect(onCancel).not.toHaveBeenCalled();
    screen.getByRole("textbox", { name: "Preset name" }).blur();
    await userEvent.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("a Jump back in card launches its preset and records when", async () => {
    settings["terminal-presets"] = [{ ...lotus, agentSlots: {} }];
    const { onLaunch } = setup();
    await userEvent.click(await screen.findByRole("button", { name: /^Lotus/ }));
    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ id: "single" }), "/Users/me/Lotus", [""], "Lotus", undefined);
    await waitFor(() => expect(saved()[0].lastOpenedAt).toEqual(expect.any(Number)));
  });

  it("the source pill is offered only where the caller can pick a remote folder", async () => {
    setup();
    await screen.findByDisplayValue("/Users/me");
    expect(screen.queryByRole("button", { name: /This Mac/ })).toBeNull();
  });

  it("a picked VPS folder stays in the form, launches with the layout and agents, and saves with its machine", async () => {
    const remote = { kind: "ssh" as const, host: "devbox-vps", user: "alwi" };
    const onPickRemote = vi.fn().mockResolvedValue({ remote, cwd: "/srv/bot" });
    const onLaunch = vi.fn();
    render(<ConfigureLayoutView onCancel={vi.fn()} onPickRemote={onPickRemote} onLaunch={onLaunch} />);
    await userEvent.click(await screen.findByRole("button", { name: /This Mac/ }));

    expect(await screen.findByRole("button", { name: "Remote folder" })).toHaveTextContent("/srv/bot");
    expect(screen.queryByText(/This is your home folder/)).toBeNull();
    await userEvent.click(screen.getByRole("radio", { name: "2" }));
    await userEvent.click(screen.getByRole("button", { name: /Claude/ }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Save as preset" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Preset name" }), "Bot");
    await userEvent.click(launchBtn());

    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ id: "2" }), "/srv/bot", [expect.stringContaining("claude"), ""], "Bot", remote);
    await waitFor(() => expect(saved()[0]).toEqual(expect.objectContaining({ name: "Bot", cwd: "/srv/bot", location: remote })));
  });

  it("on a VPS: the pill says it is connected, agents it lacks wait behind more, the button names the machine", async () => {
    const onPickRemote = vi.fn().mockResolvedValue({ remote: { kind: "ssh", host: "devbox-vps" }, cwd: "/srv/bot" });
    render(<ConfigureLayoutView onCancel={vi.fn()} onPickRemote={onPickRemote} onLaunch={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /This Mac/ }));

    expect(await screen.findByText("● connected")).toBeTruthy();
    expect(sshProbeWorkspace).toHaveBeenCalledWith({ host: "devbox-vps", user: null, port: null });
    expect(screen.getByRole("button", { name: /Claude/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Codex/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /^\+ \d+ more$/ }));
    expect(screen.getByRole("button", { name: /Codex.*not on devbox-vps/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Cursor.*not on devbox-vps/ })).toBeDisabled();
    expect(screen.getByText(/Agents run/)).toHaveTextContent("Agents run on devbox-vps");
    expect(launchBtn()).toHaveTextContent("Launch 1 pane on devbox-vps");
  });

  it("on this Mac: installed agents first, the rest behind more, marked not installed but still pickable", async () => {
    detectInstalledClis.mockResolvedValue([
      { id: "claude", installed: true }, { id: "codex", installed: false }, { id: "antigravity", installed: true },
    ]);
    setup();
    expect(await screen.findByRole("button", { name: /Antigravity/ })).toBeEnabled();
    await waitFor(() => expect(screen.queryByRole("button", { name: /Codex/ })).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: /^\+ \d+ more$/ }));
    expect(screen.getByRole("button", { name: /Codex.*not installed/ })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Fewer" }));
    expect(screen.queryByRole("button", { name: /Codex/ })).toBeNull();
  });

  it("unknown detection shows every agent, with the fixed Cursor and Copilot commands", async () => {
    const { onLaunch } = setup();
    await userEvent.click(await screen.findByRole("radio", { name: "2" }));
    await userEvent.click(screen.getByRole("button", { name: /Cursor/ }));
    await userEvent.click(screen.getByRole("button", { name: /Copilot/ }));
    await userEvent.click(launchBtn());
    expect(onLaunch).toHaveBeenCalledWith(expect.anything(), "/Users/me", [expect.stringMatching(/^cursor-agent/), expect.stringMatching(/^copilot/)], undefined, undefined);
  });

  it("opens with the layout and agents launched last time", async () => {
    const first = setup();
    await userEvent.click(await screen.findByRole("radio", { name: "2" }));
    await userEvent.click(screen.getByRole("button", { name: /Claude/ }));
    await userEvent.click(launchBtn());
    expect(first.onLaunch).toHaveBeenCalled();
    cleanup();

    setup();
    expect(await screen.findByRole("radio", { name: "2" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Remove Claude from pane 1" })).toBeInTheDocument();
  });

  it("an unreachable VPS keeps every agent: not asked is not missing", async () => {
    sshProbeWorkspace.mockRejectedValue(new Error("ssh: connect timed out"));
    const onPickRemote = vi.fn().mockResolvedValue({ remote: { kind: "ssh", host: "vps" }, cwd: "/srv" });
    render(<ConfigureLayoutView onCancel={vi.fn()} onPickRemote={onPickRemote} onLaunch={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /This Mac/ }));
    expect(await screen.findByText("● not reachable")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Codex/ })).toBeEnabled();
  });

  it("a closed picker leaves the form on this Mac; Use this Mac goes back", async () => {
    const onPickRemote = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ remote: { kind: "ssh", host: "vps" }, cwd: "/srv" });
    render(<ConfigureLayoutView onCancel={vi.fn()} onPickRemote={onPickRemote} onLaunch={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: /This Mac/ }));
    expect(screen.getByDisplayValue("/Users/me")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /This Mac/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Use this Mac" }));
    expect(screen.getByDisplayValue("/Users/me")).toBeTruthy();
  });

  it("a remote preset card launches on its machine", async () => {
    const remote = { kind: "ssh", host: "devbox-vps" };
    settings["terminal-presets"] = [{ ...lotus, cwd: "/srv/bot", agentSlots: {}, location: remote }];
    const { onLaunch } = setup();
    expect(await screen.findByText("devbox-vps:bot")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^Lotus/ }));
    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ id: "single" }), "/srv/bot", [""], "Lotus", remote);
  });

  it("ignores ⌘↵ and Esc typed in a panel drawn outside the view", async () => {
    const onLaunch = vi.fn();
    const onCancel = vi.fn();
    render(<><ConfigureLayoutView onCancel={onCancel} onLaunch={onLaunch} /><button type="button">picker row</button></>);
    await screen.findByDisplayValue("/Users/me");
    screen.getByRole("button", { name: "picker row" }).focus();
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}{Escape}");
    expect(onLaunch).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("shows five common shapes; bigger ones come from more", async () => {
    const { onLaunch } = setup();
    await screen.findByDisplayValue("/Users/me");
    expect(screen.getAllByRole("radio").map(r => r.textContent)).toEqual(["1", "2", "4", "6", "8"]);
    await userEvent.click(screen.getByRole("button", { name: /more/ }));
    await userEvent.click(screen.getByRole("radio", { name: "12" }));
    expect(screen.getByRole("radio", { name: "12" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("radio", { name: "16" })).toBeNull();
    await userEvent.click(launchBtn());
    expect(onLaunch.mock.calls[0][2]).toHaveLength(12);
  });

  it("the pencil on a card loads the preset into the form instead of opening it", async () => {
    settings["terminal-presets"] = [lotus];
    const { onLaunch } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Lotus" }));
    expect(onLaunch).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Lotus");
    expect(screen.getByDisplayValue("/Users/me/Lotus")).toBeTruthy();
  });

  it("warns when the folder is the home folder", async () => {
    setup();
    expect(await screen.findByText(/This is your home folder/)).toBeInTheDocument();
  });

  describe("preset palette", () => {
    const old = Date.now() - 30 * 86_400_000;
    const many = [
      { ...lotus, id: "a", name: "Alpha", cwd: "/Users/me/alpha", lastOpenedAt: old },
      { ...lotus, id: "b", name: "Beta", cwd: "/Users/me/beta", lastOpenedAt: Date.now(), agentSlots: { codex: 1 } },
      { ...lotus, id: "c", name: "Gamma", cwd: "/Users/me/gamma", lastOpenedAt: old, pinned: true },
    ];

    async function openPalette() {
      settings["terminal-presets"] = structuredClone(many);
      const out = setup();
      await screen.findByText("Jump back in");
      await userEvent.keyboard("{Meta>}p{/Meta}");
      return { ...out, dialog: await screen.findByRole("dialog", { name: "All presets" }) };
    }

    it("groups presets and searches by agent", async () => {
      const { dialog } = await openPalette();
      expect(within(dialog).getAllByText(/Pinned|Recent|Older/).map(n => n.textContent?.replace(/\d+$/, ""))).toEqual(["Pinned", "Recent", "Older · A–Z"]);
      await userEvent.type(within(dialog).getByRole("textbox", { name: "Search presets" }), "codex");
      expect(within(dialog).getAllByRole("option")).toHaveLength(1);
      expect(within(dialog).getByRole("option")).toHaveTextContent("Beta");
    });

    it("pins, edits with ⌘E, and deletes with undo", async () => {
      const { dialog, onLaunch } = await openPalette();
      await userEvent.click(within(dialog).getByRole("button", { name: "Pin Alpha" }));
      await waitFor(() => expect(saved().find(p => p.id === "a")?.pinned).toBe(true));

      await userEvent.click(within(dialog).getByRole("button", { name: "Delete Beta" }));
      await waitFor(() => expect(saved().map(p => p.id)).toEqual(["a", "c"]));
      await userEvent.click(within(dialog).getByRole("button", { name: "Undo" }));
      await waitFor(() => expect(saved().map(p => p.id)).toEqual(["a", "b", "c"]));

      const search = within(dialog).getByRole("textbox", { name: "Search presets" });
      await userEvent.type(search, "gamma");
      await userEvent.keyboard("{Meta>}e{/Meta}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Gamma");
      expect(onLaunch).not.toHaveBeenCalled();
    });

    it("Esc closes the palette, not the view", async () => {
      const { onCancel } = await openPalette();
      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(onCancel).not.toHaveBeenCalled();
    });
  });
});

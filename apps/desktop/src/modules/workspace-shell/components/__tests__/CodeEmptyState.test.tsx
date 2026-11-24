import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeEmptyState, shortPlace } from "../CodeEmptyState";

const item = (id: string) => ({
  preset: { id, name: `Preset ${id}`, templateId: "t", cwd: `/repo/${id}`, agentSlots: {}, createdAt: 0, updatedAt: 0 },
  template: { id: "t", name: "2", cols: 2, rows: 1, sessions: 2 },
  agentCommands: ["claude", ""],
});
const load = vi.fn();
vi.mock("@/modules/codespace/components/ConfigureLayoutView", () => ({ loadLaunchablePresets: () => load() }));

describe("CodeEmptyState", () => {
  afterEach(cleanup);

  it("offers New workspace and at most 3 saved presets, launching the one clicked", async () => {
    load.mockResolvedValue(["a", "b", "c", "d"].map(item));
    const onNew = vi.fn();
    const onLaunch = vi.fn();
    render(<CodeEmptyState onNewWorkspace={onNew} onLaunchPreset={onLaunch} />);

    fireEvent.click(screen.getByRole("button", { name: "New workspace" }));
    expect(onNew).toHaveBeenCalled();

    const rows = await screen.findAllByTitle(/^Open Preset/);
    expect(rows).toHaveLength(3);
    fireEvent.click(rows[1]);
    expect(onLaunch.mock.calls[0][0].preset.id).toBe("b");
  });

  it("shows no Jump back in without presets", async () => {
    load.mockResolvedValue([]);
    render(<CodeEmptyState onNewWorkspace={() => {}} onLaunchPreset={() => {}} />);
    await Promise.resolve();
    expect(screen.queryByText("Jump back in")).toBeNull();
  });

  it("shortens the home folder to ~ and keeps a remote host", () => {
    const base = { id: "x", name: "x", templateId: "t", agentSlots: {}, createdAt: 0, updatedAt: 0 };
    expect(shortPlace({ ...base, cwd: "/Users/me/work/app" })).toBe("~/work/app");
    expect(shortPlace({ ...base, cwd: "/home/me" })).toBe("~");
    expect(shortPlace({ ...base, cwd: "/srv/app", location: { kind: "ssh", host: "vps" } })).toBe("vps:/srv/app");
  });
});

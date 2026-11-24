import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdatePill } from "../components/UpdatePill";
import { AgentClisSection } from "../sections/AgentClisSection";
import { LotusAppUpdate } from "../sections/UpdatesSection";
import { resetAppUpdateForTest } from "../services/app-update";
import { resetCliUpdatesForTest, type CliUpdateStatus } from "../services/cli-updates";

const row = (patch: Partial<CliUpdateStatus>): CliUpdateStatus => ({
  id: "codex",
  name: "Codex",
  path: "/x/codex",
  current: "0.166.0",
  latest: "0.167.0",
  state: "update-available",
  updater: "Built-in updater",
  command: "codex update",
  canRun: true,
  ...patch,
});

const listRunners = vi.fn();
const saveRunnerConfig = vi.fn();
vi.mock("@/lib/tauri-api", () => ({
  listRunners: (...a: unknown[]) => listRunners(...a),
  saveRunnerConfig: (...a: unknown[]) => saveRunnerConfig(...a),
  deleteRunnerConfig: vi.fn(),
  setCliPath: vi.fn(),
  openExternalLink: vi.fn(),
}));
const runner = (id: string, name: string, extra = {}) => ({
  id, name, installed: true, path: `/x/${id}`, command: id, skip_permissions: false, extra_flags: "", resume_on_reopen: true, ...extra,
});
beforeEach(() => {
  listRunners.mockReset().mockResolvedValue({ runners: [runner("claude", "Claude Code"), runner("codex", "Codex"), runner("cursor", "Cursor Agent")] });
  saveRunnerConfig.mockReset().mockResolvedValue(undefined);
});

const fresh = { checkedAt: Date.now() };

afterEach(() => {
  resetCliUpdatesForTest();
  resetAppUpdateForTest();
});

describe("UpdatePill", () => {
  it("is absent when every CLI is up to date", () => {
    resetCliUpdatesForTest({ ...fresh, items: [row({ state: "up-to-date", latest: "0.166.0" })] });
    render(<UpdatePill />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names only the CLIs Lotus can update, not manual or unknown ones", () => {
    resetCliUpdatesForTest({
      ...fresh,
      items: [
        row({}),
        row({ id: "cursor", name: "Cursor Agent", state: "latest-unknown", latest: null }),
        row({ id: "gemini", name: "Gemini CLI", state: "update-manually", canRun: false }),
      ],
    });
    render(<UpdatePill />);
    expect(screen.getByRole("button", { name: "Updates available: Codex" })).toBeInTheDocument();
  });

  it("reports a failed run until it is retried", () => {
    resetCliUpdatesForTest({ ...fresh, items: [row({})], results: { codex: { ok: false, version: "0.166.0", message: "exit 1" } } });
    render(<UpdatePill />);
    expect(screen.getByRole("button", { name: "Update failed: Codex" })).toBeInTheDocument();
  });
});

describe("Lotus self-update", () => {
  it("offers Restart to update only once the new build is downloaded", () => {
    resetAppUpdateForTest({ enabled: true, phase: "downloading", version: "0.2.0", checkedAt: Date.now() });
    const { rerender } = render(<UpdatePill />);
    expect(screen.queryByRole("button", { name: /Restart to update/ })).toBeNull();
    resetAppUpdateForTest({ enabled: true, phase: "ready", version: "0.2.0", checkedAt: Date.now() });
    rerender(<UpdatePill />);
    expect(screen.getByRole("button", { name: /Restart to update/ })).toBeEnabled();
  });

  it("shows the release notes open once ready, closed while downloading, and toggles them", () => {
    const notes = "Reworked task list\n\n### New\n\n- Report a bug from the app.";
    resetAppUpdateForTest({ enabled: true, phase: "downloading", version: "0.2.0", notes, date: "2026-11-19 10:00:00.0 +00:00:00", checkedAt: Date.now() });
    const { rerender } = render(<LotusAppUpdate />);
    const toggle = screen.getByRole("button", { name: /What's new/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Reworked task list")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText("Reworked task list")).toBeInTheDocument();
    expect(screen.getByText("Report a bug from the app.")).toBeInTheDocument();
    expect(screen.getByText("Lotus 0.2.0 · November 19, 2026")).toBeInTheDocument();

    resetAppUpdateForTest({ enabled: true, phase: "ready", version: "0.3.0", notes: "Title only", checkedAt: Date.now() });
    rerender(<LotusAppUpdate key="ready" />);
    expect(screen.getByRole("button", { name: /What's new/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Title only")).toBeInTheDocument();
    expect(screen.queryByLabelText("Release notes")).toBeNull();
  });

  it("has no What's new when the feed sent no notes", () => {
    resetAppUpdateForTest({ enabled: true, phase: "ready", version: "0.2.0", checkedAt: Date.now() });
    render(<LotusAppUpdate />);
    expect(screen.queryByRole("button", { name: /What's new/ })).toBeNull();
  });

  it("shows the version and a disabled button, not the dev note, in a dev build", () => {
    resetAppUpdateForTest({ enabled: false });
    render(<LotusAppUpdate />);
    expect(screen.queryByText(/release builds only/)).toBeNull();
    expect(screen.getByRole("button", { name: "Check for a new Lotus version" })).toBeDisabled();
    expect(screen.getByTitle("Self-update runs in release builds only")).toBeInTheDocument();
  });
});

describe("AgentClisSection", () => {
  it("offers a copyable command, not a button, for a Homebrew install", async () => {
    listRunners.mockResolvedValue({ runners: [runner("gemini", "Gemini CLI")] });
    resetCliUpdatesForTest({
      ...fresh,
      items: [row({ id: "gemini", name: "Gemini CLI", state: "update-manually", canRun: false, updater: "Homebrew", command: "brew upgrade gemini" })],
    });
    render(<AgentClisSection />);
    expect(await screen.findByText("Update in terminal")).toBeInTheDocument();
    expect(screen.getByText("brew upgrade gemini")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Update all/ })).toBeNull();
  });

  it("keeps the log of a failed run open with a retry", async () => {
    resetCliUpdatesForTest({
      ...fresh,
      items: [row({})],
      logs: { codex: ["$ codex update", "error: network"] },
      results: { codex: { ok: false, version: "0.166.0", message: "The updater exited with exit status: 1." } },
    });
    render(<AgentClisSection />);
    expect(await screen.findByText(/error: network/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeEnabled();
  });

  it("merges runners and updates: update row, up-to-date row, unknown latest offers its updater only when opened", async () => {
    resetCliUpdatesForTest({
      ...fresh,
      items: [
        row({}),
        row({ id: "claude", name: "Claude Code", state: "up-to-date", current: "2.1.0", latest: "2.1.0" }),
        row({ id: "cursor", name: "Cursor Agent", state: "latest-unknown", latest: null, current: "2026.10.01" }),
      ],
    });
    render(<AgentClisSection />);
    expect(await screen.findByText("0.167.0")).toBeInTheDocument();
    expect(screen.getByText("1 update · checked just now")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Update" })).toHaveLength(1);
    expect(screen.getByText("Up to date")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run updater" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Update all/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show settings for Cursor Agent" }));
    expect(screen.getByRole("button", { name: "Run updater" })).toBeEnabled();
  });

  it("offers the install command and a Locate button for a CLI that is not installed", async () => {
    listRunners.mockResolvedValue({ runners: [runner("claude", "Claude Code"), runner("antigravity", "Antigravity", { installed: false, path: null })] });
    resetCliUpdatesForTest({ ...fresh, items: [] });
    render(<AgentClisSection />);
    expect(await screen.findByText("curl -fsSL https://antigravity.google/cli/install.sh | bash")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy the Antigravity install command" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Locate Antigravity on this Mac" })).toBeInTheDocument();
  });

  it("offers Update all only for more than one update", async () => {
    resetCliUpdatesForTest({ ...fresh, items: [row({}), row({ id: "claude", name: "Claude Code", current: "1", latest: "2" })] });
    render(<AgentClisSection />);
    expect(await screen.findByRole("button", { name: /Update all/ })).toBeEnabled();
  });

  it("lists a runner with no update info and expands its flags", async () => {
    resetCliUpdatesForTest({ ...fresh, items: [] });
    render(<AgentClisSection />);
    expect(await screen.findByText("Codex")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show settings for Codex" }));
    fireEvent.click(screen.getByRole("switch", { name: "Skip permissions for Codex" }));
    await waitFor(() => expect(saveRunnerConfig).toHaveBeenCalledWith("codex", expect.objectContaining({ id: "codex", skip_permissions: true })));
    expect(screen.getByRole("switch", { name: "Resume conversation on reopen for Codex" })).toBeInTheDocument();
    const flags = screen.getByPlaceholderText("e.g. --model opus");
    fireEvent.change(flags, { target: { value: "--x" } });
    fireEvent.blur(flags);
    await waitFor(() => expect(saveRunnerConfig).toHaveBeenCalledWith("codex", expect.objectContaining({ extra_flags: "--x" })));
  });
});

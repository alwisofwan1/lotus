import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CodeCanvasProjectMeta } from "@/lib/tauri/codecanvas";

const listSshHosts = vi.fn();
const listDirEntriesSsh = vi.fn();
const machineReadiness = vi.fn();
const machineAccessLogin = vi.fn();

vi.mock("@/lib/tauri-api", () => ({
  listSshHosts: (...args: unknown[]) => listSshHosts(...args),
  listDirEntriesSsh: (...args: unknown[]) => listDirEntriesSsh(...args),
  machineReadiness: (...args: unknown[]) => machineReadiness(...args),
  machineAccessLogin: (...args: unknown[]) => machineAccessLogin(...args),
}));

const { CanvasAddProjectPanel } = await import("../panels/CanvasAddProjectPanel");

const project = (over: Partial<CodeCanvasProjectMeta>): CodeCanvasProjectMeta => ({
  id: "cp_1",
  rootDir: "/repo",
  alias: null,
  position: 0,
  updatedAt: 1,
  lastOpenedAt: 1,
  ...over,
});

function panel(over: Partial<Parameters<typeof CanvasAddProjectPanel>[0]> = {}) {
  const props = {
    projects: [] as CodeCanvasProjectMeta[],
    onPickLocalFolder: vi.fn(),
    onOpenProject: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<CanvasAddProjectPanel {...props} />);
  return props;
}

describe("Add project", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSshHosts.mockResolvedValue([]);
    listDirEntriesSsh.mockResolvedValue([]);
    machineReadiness.mockResolvedValue({ connected: false, access: null });
    machineAccessLogin.mockResolvedValue(null);
  });

  it("offers the local folder first, and does not wait on ~/.ssh/config to do it", async () => {
    listSshHosts.mockRejectedValue(new Error("no config"));
    const props = panel();

    await userEvent.click(screen.getByText("Local folder…"));
    expect(props.onPickLocalFolder).toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
  });

  it("lists machines from ~/.ssh/config once they arrive", async () => {
    listSshHosts.mockResolvedValue([{ alias: "devbox-vps", hostname: "103.1.1.1", user: "root", port: null }]);
    panel();
    expect(await screen.findByText("devbox-vps")).toBeTruthy();
  });

  it("says a git-only alias cannot be used, instead of hiding it", async () => {
    listSshHosts.mockResolvedValue([{ alias: "github.com", hostname: "github.com", user: "git", port: null }]);
    panel();

    await userEvent.click(await screen.findByRole("button", { name: /Git-only SSH alias/ }));
    const row = (await screen.findByText("github.com")).closest("button");
    expect(row).toBeTruthy();
    expect(row?.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/does not provide an interactive shell/)).toBeTruthy();
  });

  it("offers a machine typed by hand when the list does not already have it", async () => {
    panel();
    await userEvent.type(screen.getByLabelText(/Search machines/), "root@103.20.10.5");
    expect(await screen.findByText("New machine")).toBeTruthy();
    expect(screen.getByText("Connect to root@103.20.10.5")).toBeTruthy();
  });

  it("tells an operator with no machines what to do rather than showing a blank list", async () => {
    panel();
    expect(
      await screen.findByText(/does not list a usable host/),
    ).toBeTruthy();
  });

  it("browses the chosen machine, starting somewhere a person recognises", async () => {
    listSshHosts.mockResolvedValue([{ alias: "devbox-vps", hostname: "x", user: "root", port: null }]);
    listDirEntriesSsh.mockResolvedValue([
      { name: "api", path: "/root/api", isGitRepo: true, hasPackageJson: true },
      { name: "backups", path: "/root/backups", isGitRepo: false, hasPackageJson: false },
    ]);
    panel();

    await userEvent.click(await screen.findByText("devbox-vps"));

    await waitFor(() => expect(listDirEntriesSsh).toHaveBeenCalledWith({ host: "devbox-vps", user: "root" }, "/root"));
    expect(await screen.findByText("api")).toBeTruthy();
    expect(screen.getByText("git")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use this folder \(root\)/ })).toBeTruthy();
  });

  it("opens the chosen folder as a project on that machine", async () => {
    listSshHosts.mockResolvedValue([{ alias: "devbox-vps", hostname: "x", user: "root", port: 2222 }]);
    listDirEntriesSsh.mockResolvedValue([
      { name: "api", path: "/root/api", isGitRepo: true, hasPackageJson: false },
    ]);
    const props = panel();

    await userEvent.click(await screen.findByText("devbox-vps"));
    await userEvent.click(await screen.findByText("api"));
    // A click only selects; it must not have gone in.
    expect(listDirEntriesSsh).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: /Use api/ }));

    expect(props.onOpenProject).toHaveBeenCalledWith("/root/api", {
      kind: "ssh",
      host: "devbox-vps",
      user: "root",
      port: 2222,
    });
  });

  it("shows why a directory could not be read, rather than an empty folder", async () => {
    listSshHosts.mockResolvedValue([{ alias: "devbox-vps", hostname: "x", user: "root", port: null }]);
    listDirEntriesSsh.mockRejectedValue(
      new Error("Cannot open /root on this machine — it does not exist, or you do not have permission."),
    );
    panel();

    await userEvent.click(await screen.findByText("devbox-vps"));
    expect(await screen.findByText("That folder could not be opened")).toBeTruthy();
    expect(screen.getByText("Go up one level, or pick another folder.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Go up one level" })).toBeTruthy();
  });

  it("does not offer to use a folder it could not read", async () => {
    listSshHosts.mockResolvedValue([{ alias: "devbox-vps", hostname: "x", user: "root", port: null }]);
    listDirEntriesSsh.mockRejectedValue(new Error("SSH master did not create control socket within 8 s"));
    panel();

    await userEvent.click(await screen.findByText("devbox-vps"));
    await screen.findByText(/did not answer in time/);
    expect(screen.getByRole("button", { name: /Use this folder/ }).hasAttribute("disabled")).toBe(true);
  });

  it("keeps our internals out of the headline but one click away", async () => {
    listSshHosts.mockResolvedValue([{ alias: "devbox-vps", hostname: "x", user: "root", port: null }]);
    listDirEntriesSsh.mockRejectedValue(
      new Error("SSH master did not create control socket within 8 s (target: alwi@devbox-vps)."),
    );
    panel();

    await userEvent.click(await screen.findByText("devbox-vps"));
    expect(await screen.findByText("devbox-vps did not answer in time")).toBeTruthy();
    expect(screen.getByText(/Technical details/)).toBeTruthy();
    expect(screen.getByText(/control socket/)).toBeTruthy();
  });

  it("can ask the same directory again after a failure", async () => {
    listSshHosts.mockResolvedValue([{ alias: "devbox-vps", hostname: "x", user: "root", port: null }]);
    listDirEntriesSsh.mockRejectedValueOnce(new Error("Connection timed out"));
    panel();

    await userEvent.click(await screen.findByText("devbox-vps"));
    await screen.findByText(/did not answer in time/);

    listDirEntriesSsh.mockResolvedValue([
      { name: "api", path: "/root/api", isGitRepo: true, hasPackageJson: false },
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("api")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use this folder/ }).hasAttribute("disabled")).toBe(false);
  });

  it("says which machines are already connected", async () => {
    listSshHosts.mockResolvedValue([{ alias: "devbox-vps", hostname: "x", user: "root", port: null }]);
    machineReadiness.mockResolvedValue({ connected: true, access: null });
    panel();

    expect(await screen.findByText("Connected")).toBeTruthy();
  });

  it("says when a machine needs a browser sign-in, and what clicking will do", async () => {
    listSshHosts.mockResolvedValue([
      { alias: "devbox-vps", hostname: "ssh.example.com", user: "root", port: null, accessHostname: "ssh.example.com" },
    ]);
    machineReadiness.mockResolvedValue({
      connected: false,
      access: { state: "needs-login", hostname: "ssh.example.com" },
    });
    panel();

    expect(await screen.findByText("Sign in")).toBeTruthy();
  });

  it("opens the sign-in instead of browsing a machine whose session has lapsed", async () => {
    listSshHosts.mockResolvedValue([
      { alias: "devbox-vps", hostname: "ssh.example.com", user: "root", port: null, accessHostname: "ssh.example.com" },
    ]);
    machineReadiness.mockResolvedValue({
      connected: false,
      access: { state: "needs-login", hostname: "ssh.example.com" },
    });
    panel();

    await screen.findByText("Sign in");
    await userEvent.click(screen.getByText("devbox-vps"));

    expect(machineAccessLogin).toHaveBeenCalledWith("ssh.example.com");
    expect(listDirEntriesSsh).not.toHaveBeenCalled();
    expect(await screen.findByText(/Sign in to reach devbox-vps/)).toBeTruthy();
  });

  it("offers the sign-in link when cloudflared reports one, for when the browser did not open", async () => {
    listSshHosts.mockResolvedValue([
      { alias: "devbox-vps", hostname: "ssh.example.com", user: "root", port: null, accessHostname: "ssh.example.com" },
    ]);
    machineReadiness.mockResolvedValue({
      connected: false,
      access: { state: "needs-login", hostname: "ssh.example.com" },
    });
    machineAccessLogin.mockResolvedValue("https://ssh.example.com/cdn-cgi/access/cli?aud=abc");
    panel();

    await screen.findByText("Sign in");
    await userEvent.click(screen.getByText("devbox-vps"));

    expect(await screen.findByText(/Browser did not open/)).toBeTruthy();
    expect(screen.getByText("https://ssh.example.com/cdn-cgi/access/cli?aud=abc")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
  });

  it("stays quiet about a link cloudflared never reported", async () => {
    listSshHosts.mockResolvedValue([
      { alias: "devbox-vps", hostname: "ssh.example.com", user: "root", port: null, accessHostname: "ssh.example.com" },
    ]);
    machineReadiness.mockResolvedValue({
      connected: false,
      access: { state: "needs-login", hostname: "ssh.example.com" },
    });
    machineAccessLogin.mockResolvedValue(null);
    panel();

    await screen.findByText("Sign in");
    await userEvent.click(screen.getByText("devbox-vps"));
    await screen.findByText(/Sign in to reach devbox-vps/);

    expect(screen.queryByText(/Browser did not open/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
  });

  it("browses straight away once the machine is signed in", async () => {
    listSshHosts.mockResolvedValue([
      { alias: "devbox-vps", hostname: "ssh.example.com", user: "root", port: null, accessHostname: "ssh.example.com" },
    ]);
    machineReadiness.mockResolvedValue({
      connected: false,
      access: { state: "signed-in", hostname: "ssh.example.com" },
    });
    panel();

    await screen.findByText("devbox-vps");
    await userEvent.click(screen.getByText("devbox-vps"));

    await waitFor(() => expect(listDirEntriesSsh).toHaveBeenCalled());
    expect(machineAccessLogin).not.toHaveBeenCalled();
  });

  describe("sign-in polling", () => {
    const host = { alias: "devbox-vps", hostname: "ssh.example.com", user: "root", port: null, accessHostname: "ssh.example.com" };
    const needsLogin = { connected: false, access: { state: "needs-login", hostname: "ssh.example.com" } };

    async function openSignIn() {
      // Only the poll's timer is faked, so findBy* keeps working on real timers.
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      listSshHosts.mockResolvedValue([host]);
      machineReadiness.mockResolvedValue(needsLogin);
      panel();
      await screen.findByText("Sign in");
      fireEvent.click(screen.getByText("devbox-vps"));
      await screen.findByText(/Sign in to reach devbox-vps/);
    }
    afterEach(() => vi.useRealTimers());

    it("keeps waiting while the token is still missing, or the probe fails", async () => {
      await openSignIn();
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      machineReadiness.mockRejectedValue(new Error("probe failed"));
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(screen.getByText("Waiting for sign-in…")).toBeTruthy();
      expect(listDirEntriesSsh).not.toHaveBeenCalled();
    });

    it("moves on to browsing by itself once the sign-in lands", async () => {
      await openSignIn();
      machineReadiness.mockResolvedValue({ connected: false, access: { state: "signed-in", hostname: "ssh.example.com" } });
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      expect(listDirEntriesSsh).toHaveBeenCalled();
    });

    it("lets the operator continue by hand when the check never reports signed-in", async () => {
      await openSignIn();
      fireEvent.click(screen.getByRole("button", { name: "I've signed in, continue" }));
      await waitFor(() => expect(listDirEntriesSsh).toHaveBeenCalled());
    });

    it("stops polling when the operator goes back", async () => {
      await openSignIn();
      const before = machineReadiness.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Back to machines" }));
      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      expect(machineReadiness.mock.calls.length).toBe(before);
      expect(listDirEntriesSsh).not.toHaveBeenCalled();
    });
  });

  it("never labels a machine it has not heard back about", async () => {
    listSshHosts.mockResolvedValue([{ alias: "devbox-vps", hostname: "x", user: "root", port: null }]);
    machineReadiness.mockRejectedValue(new Error("cannot tell"));
    panel();

    await screen.findByText("devbox-vps");
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByText("Sign in")).toBeNull();
  });

  it("folds git-only aliases behind one toggle that expands them, still disabled", async () => {
    listSshHosts.mockResolvedValue([
      { alias: "devbox-vps", hostname: "x", user: "root", port: null },
      { alias: "github-work", hostname: "github.com", user: "git", port: null },
    ]);
    panel();
    await screen.findByText("devbox-vps");
    expect(screen.queryByText("github-work")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /1 Git-only SSH alias hidden/ }));
    const row = screen.getByText("github-work").closest("button");
    expect(row?.hasAttribute("disabled")).toBe(true);
  });

  it("moves the highlight with the arrow keys and opens it with Enter", async () => {
    listSshHosts.mockResolvedValue([
      { alias: "alpha", hostname: "a", user: "root", port: null },
      { alias: "beta", hostname: "b", user: "root", port: null },
    ]);
    panel();
    await screen.findByText("beta");
    // Order: This Mac, alpha, beta. ↓↓ lands on beta.
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await waitFor(() => expect(listDirEntriesSsh).toHaveBeenCalledWith({ host: "beta", user: "root" }, "/root"));
  });

  it("closes on Escape", async () => {
    const props = panel();
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalled();
  });

  it("goes into a folder with Enter or a double click, and up with the left arrow", async () => {
    listSshHosts.mockResolvedValue([{ alias: "devbox-vps", hostname: "x", user: "root", port: null }]);
    listDirEntriesSsh
      .mockResolvedValueOnce([{ name: "api", path: "/root/api", isGitRepo: true, hasPackageJson: false }])
      .mockResolvedValueOnce([])
      .mockResolvedValue([]);
    panel();
    await userEvent.click(await screen.findByText("devbox-vps"));
    await userEvent.dblClick(await screen.findByText("api"));
    await waitFor(() => expect(listDirEntriesSsh).toHaveBeenLastCalledWith(expect.anything(), "/root/api"));
    await screen.findByText("No subfolders here.");
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(listDirEntriesSsh).toHaveBeenLastCalledWith(expect.anything(), "/root"));
  });

  it("uses the selected folder with Cmd+Enter", async () => {
    listSshHosts.mockResolvedValue([{ alias: "devbox-vps", hostname: "x", user: "root", port: null }]);
    listDirEntriesSsh.mockResolvedValue([{ name: "api", path: "/root/api", isGitRepo: false, hasPackageJson: false }]);
    const props = panel();
    await userEvent.click(await screen.findByText("devbox-vps"));
    await userEvent.click(await screen.findByText("api"));
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(props.onOpenProject).toHaveBeenCalledWith("/root/api", expect.objectContaining({ kind: "ssh", host: "devbox-vps" }));
  });

  it("lists known projects on the machine first, and opens one in a click", async () => {
    listSshHosts.mockResolvedValue([{ alias: "devbox-vps", hostname: "x", user: "root", port: null }]);
    listDirEntriesSsh.mockResolvedValue([{ name: "api", path: "/root/api", isGitRepo: false, hasPackageJson: false }]);
    const props = panel({
      projects: [
        project({ id: "p1", rootDir: "/srv/bot-server", location: { kind: "ssh", host: "devbox-vps", user: "root", port: null, label: null } }),
        project({ id: "p2", rootDir: "/elsewhere" }),
      ],
    });
    await userEvent.click(await screen.findByText("devbox-vps"));
    expect(await screen.findByText("On this machine")).toBeTruthy();
    expect(screen.queryByText("/elsewhere")).toBeNull();
    await userEvent.click(screen.getByText("bot-server"));
    expect(props.onOpenProject).toHaveBeenCalledWith("/srv/bot-server", expect.objectContaining({ kind: "ssh", host: "devbox-vps" }));
  });
});

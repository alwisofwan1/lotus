import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The real panel lists ~/.ssh/config hosts and browses over Tauri; only its hand-off matters here.
vi.mock("@/modules/codecanvas/components/panels/CanvasAddProjectPanel", () => ({
  CanvasAddProjectPanel: ({ onOpenProject, onPickLocalFolder }: { onOpenProject: (r: string, l: unknown) => void; onPickLocalFolder: () => void }) => (
    <div>
      <button type="button" onClick={() => onOpenProject("/home/alwi/app/", { kind: "ssh", host: "devbox-vps", user: "alwi", port: 22 })}>vps</button>
      <button type="button" onClick={() => onOpenProject("/x", { kind: "local" })}>local</button>
      <button type="button" onClick={onPickLocalFolder}>pick local</button>
    </div>
  ),
}));

import { RemoteFolderPicker, remoteWorkspaceLabel } from "../RemoteFolderPicker";

describe("RemoteFolderPicker", () => {
  it("names the workspace host:folder", () => {
    expect(remoteWorkspaceLabel("devbox-vps", "/home/alwi/app/")).toBe("devbox-vps:app");
    expect(remoteWorkspaceLabel("vps", "/")).toBe("vps:/");
  });

  it("opens a folder on another machine as its SSH target, and nothing for a local one", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<RemoteFolderPicker onOpen={onOpen} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "vps" }));
    expect(onOpen).toHaveBeenCalledWith({ host: "devbox-vps", user: "alwi", port: 22 }, "/home/alwi/app/", "devbox-vps:app");
    fireEvent.click(screen.getByRole("button", { name: "local" }));
    expect(onOpen).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "pick local" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

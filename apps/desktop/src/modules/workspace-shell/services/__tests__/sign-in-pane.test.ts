import { describe, expect, it } from "vitest";
import { pickSignInWorkspace, requestSignInPane, onSignInPaneRequest, sshKey } from "../sign-in-pane";

describe("sign-in pane routing", () => {
  it("keys a machine the way usage_remote does", () => {
    expect(sshKey({ host: " Devbox-VPS " })).toBe("devbox-vps");
    expect(sshKey({ host: "vps", user: "me", port: 2222 })).toBe("me@vps:2222");
  });

  it("opens on the machine the account lives on: the active workspace if it is there, else the first", () => {
    const ws = [{ id: "mac" }, { id: "vps-a", target: "devbox-vps" }, { id: "vps-b", target: "devbox-vps" }];
    expect(pickSignInWorkspace(ws, "vps-b", "devbox-vps")).toBe("vps-b");
    expect(pickSignInWorkspace(ws, "mac", "devbox-vps")).toBe("vps-a");
    expect(pickSignInWorkspace(ws, "vps-a", null)).toBe("mac");
    expect(pickSignInWorkspace(ws, "mac", "other")).toBeNull();
  });

  it("passes the machine to the listener", () => {
    const heard: [string, string | null][] = [];
    const off = onSignInPaneRequest((c, t) => (heard.push([c, t]), true));
    requestSignInPane("login", "devbox-vps");
    requestSignInPane("login");
    off();
    expect(heard).toEqual([["login", "devbox-vps"], ["login", null]]);
  });
});

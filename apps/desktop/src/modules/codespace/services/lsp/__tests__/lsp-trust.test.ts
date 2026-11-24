import { describe, expect, it } from "vitest";
import { isFolderTrusted, trustKey } from "../lsp-trust";

const ssh = { kind: "ssh", host: "box", user: "me", port: 2222 } as never;

describe("lsp trust", () => {
  it("keys a folder by its machine", () => {
    expect(trustKey(null, "/repo/")).toBe("local:/repo");
    expect(trustKey(ssh, "/repo")).toBe("ssh:me@box:2222:/repo");
  });

  it("trusts the folder and folders inside it, on the same machine only", () => {
    const trusted = ["local:/work"];
    expect(isFolderTrusted(trusted, null, "/work")).toBe(true);
    expect(isFolderTrusted(trusted, null, "/work/app")).toBe(true);
    expect(isFolderTrusted(trusted, null, "/workshop")).toBe(false);
    expect(isFolderTrusted(trusted, ssh, "/work")).toBe(false);
    expect(isFolderTrusted([], null, "/work")).toBe(false);
  });
});

import { languageServerText } from "@/modules/codespace/components/workbench/WorkbenchStatusBar";

describe("languageServerText", () => {
  it("says what the server is doing", () => {
    expect(languageServerText({ kind: "ready", label: "rust-analyzer", progress: "Indexing 40%" }).text).toBe("rust-analyzer: Indexing 40%");
    expect(languageServerText({ kind: "missing", label: "gopls", installHint: "go install golang.org/x/tools/gopls@latest" }).title)
      .toContain("go install golang.org/x/tools/gopls@latest");
    expect(languageServerText({ kind: "untrusted", label: "TypeScript" }).text).toBe("TypeScript off");
  });
});

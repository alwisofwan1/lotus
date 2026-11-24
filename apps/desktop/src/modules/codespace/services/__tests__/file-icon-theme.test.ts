import { describe, expect, it } from "vitest";
import {
  resolveWorkbenchFileIcon,
  resolveWorkbenchFolderIcon,
} from "@/modules/codespace/services/file-icon-theme";

describe("file-icon-theme", () => {
  it("resolves common editor file icons by filename, extension, and language", () => {
    expect(resolveWorkbenchFileIcon("/workspace/project/package.json").id).toBe("nodejs");
    expect(resolveWorkbenchFileIcon("/workspace/project/src/App.tsx").id).toBe("react_ts");
    expect(resolveWorkbenchFileIcon("/workspace/project/src/index.ts").id).toBe("typescript");
    expect(resolveWorkbenchFileIcon("/workspace/project/src/index.js").id).toBe("javascript");
    expect(resolveWorkbenchFileIcon("/workspace/project/README.md").id).toBe("markdown");
    expect(resolveWorkbenchFileIcon("/workspace/project/bun.lock").id).toBe("bun");
  });

  it("resolves known folder icons with open and closed variants", () => {
    expect(resolveWorkbenchFolderIcon("/workspace/project/src", false).id).toBe("folder-src");
    expect(resolveWorkbenchFolderIcon("/workspace/project/src", true).id).toBe("folder-src-open");
    expect(resolveWorkbenchFolderIcon("/workspace/project/src-tauri", false).id).toBe("folder-src-tauri");
    expect(resolveWorkbenchFolderIcon("/workspace/project/src-tauri", true).id).toBe("folder-src-tauri-open");
  });

  it("falls back to generic self-contained assets for unknown associations", () => {
    expect(resolveWorkbenchFileIcon("/workspace/project/unknown.custom").id).toBe("file");
    expect(resolveWorkbenchFolderIcon("/workspace/project/domain-specific", false).id).toBe("folder");
    expect(resolveWorkbenchFolderIcon("/workspace/project/domain-specific", true).id).toBe("folder-open");
  });
});

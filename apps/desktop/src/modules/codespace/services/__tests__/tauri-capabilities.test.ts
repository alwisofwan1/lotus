import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readMainAppAllowedCommands(): string[] {
  const content = readFileSync(
    join(process.cwd(), "src-tauri/permissions/main-app-commands.toml"),
    "utf8",
  );
  const match = content.match(/commands\.allow\s*=\s*\[([\s\S]*?)\]/);
  if (!match) return [];
  return Array.from(match[1].matchAll(/"([^"]+)"/g), ([, command]) => command);
}

describe("tauri capabilities", () => {
  it("allows the shell shutdown policy to close the current window", () => {
    const capabilityPaths = [
      "src-tauri/capabilities/default.json",
      "src-tauri/gen/schemas/capabilities.json",
    ];

    for (const capabilityPath of capabilityPaths) {
      const capabilityFile = JSON.parse(
        readFileSync(join(process.cwd(), capabilityPath), "utf8"),
      ) as { default?: { permissions?: string[] }; permissions?: string[] };
      const permissions = capabilityFile.default?.permissions ?? capabilityFile.permissions;

      expect(permissions).toEqual(
        expect.arrayContaining([
          "core:window:allow-close",
          "core:window:allow-destroy",
          "core:window:allow-set-title",
        ]),
      );
    }
  });

  it("allows the theme to pin the native window appearance in release and dev", () => {
    // Both tauri.conf.json and tauri.dev.conf.json load the "default" capability.
    for (const capabilityPath of [
      "src-tauri/capabilities/default.json",
      "src-tauri/gen/schemas/capabilities.json",
    ]) {
      const capabilityFile = JSON.parse(
        readFileSync(join(process.cwd(), capabilityPath), "utf8"),
      ) as { default?: { permissions?: string[] }; permissions?: string[] };
      const permissions = capabilityFile.default?.permissions ?? capabilityFile.permissions;

      expect(permissions).toContain("core:window:allow-set-theme");
    }
    for (const configPath of ["src-tauri/tauri.conf.json", "src-tauri/tauri.dev.conf.json"]) {
      const config = JSON.parse(readFileSync(join(process.cwd(), configPath), "utf8")) as {
        app?: { security?: { capabilities?: string[] } };
      };
      expect(config.app?.security?.capabilities).toContain("default");
    }
  });

  it("allows all CodeSpace source control commands", () => {
    expect(readMainAppAllowedCommands()).toEqual(
      expect.arrayContaining([
        "codespace_git_status",
        "codespace_git_repo_summary",
        "codespace_git_stage_file",
        "codespace_git_stage_all",
        "codespace_git_unstage_file",
        "codespace_git_unstage_all",
        "codespace_git_discard_all_changes",
        "codespace_git_commit",
        "codespace_git_diff_file",
        "codespace_git_diff_file_content",
      ]),
    );
  });

  it("allows CodeSpace editor create commands", () => {
    expect(readMainAppAllowedCommands()).toEqual(
      expect.arrayContaining([
        "editor_create_file",
        "editor_create_directory",
        "editor_delete_entry",
      ]),
    );
  });
});

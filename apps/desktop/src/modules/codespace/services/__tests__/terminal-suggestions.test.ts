import { describe, expect, it } from "vitest";

import {
  clearTerminalSuggestionCachesForTest,
  getSuggestionRemainder,
  getTerminalSuggestions,
} from "../terminal-suggestions";

describe("terminal suggestions", () => {
  it("surfaces curated git suggestions for subcommand prefixes", () => {
    clearTerminalSuggestionCachesForTest();

    const suggestions = getTerminalSuggestions("git ch", [], { cwd: "/tmp/project" });

    expect(suggestions.map((suggestion) => suggestion.command)).toContain(
      "git checkout",
    );
  });

  it("prioritizes curated shell suggestions for root command prefixes", () => {
    clearTerminalSuggestionCachesForTest();

    const suggestions = getTerminalSuggestions("g", [], { cwd: "/tmp/project" });

    expect(suggestions[0]?.command).toBe("git status");
    expect(suggestions.map((suggestion) => suggestion.command)).toContain("git checkout");
  });

  it("includes custom agent commands when their prefix is explicit", () => {
    clearTerminalSuggestionCachesForTest();

    const claudeSuggestions = getTerminalSuggestions("cl", [], { cwd: "/tmp/project" });
    const ccsSuggestions = getTerminalSuggestions("ccs", [], { cwd: "/tmp/project" });

    expect(claudeSuggestions.map((suggestion) => suggestion.command)).toContain("claude");
    expect(claudeSuggestions.map((suggestion) => suggestion.command)).toContain(
      "claude --dangerously-skip-permissions",
    );
    expect(ccsSuggestions.map((suggestion) => suggestion.command)).toContain("ccs hss");
    expect(ccsSuggestions.map((suggestion) => suggestion.command)).toContain(
      "ccs hss --dangerously-skip-permissions",
    );
  });

  it("includes common developer workflow presets for explicit prefixes", () => {
    clearTerminalSuggestionCachesForTest();

    const ripgrepSuggestions = getTerminalSuggestions("rg", [], { cwd: "/tmp/project" });
    const bunSuggestions = getTerminalSuggestions("bun", [], { cwd: "/tmp/project" });
    const dockerSuggestions = getTerminalSuggestions("docker c", [], { cwd: "/tmp/project" });

    expect(ripgrepSuggestions.map((suggestion) => suggestion.command)).toContain("rg --files");
    expect(bunSuggestions.map((suggestion) => suggestion.command)).toContain("bun run dev");
    expect(dockerSuggestions.map((suggestion) => suggestion.command)).toContain("docker compose up");
  });

  it("includes workspace tool presets for explicit prefixes", () => {
    clearTerminalSuggestionCachesForTest();

    const lazyGitSuggestions = getTerminalSuggestions("la", [], { cwd: "/tmp/project" });
    const lazyDockerSuggestions = getTerminalSuggestions("lazyd", [], { cwd: "/tmp/project" });
    const yaziSuggestions = getTerminalSuggestions("ya", [], { cwd: "/tmp/project" });
    const zoxideSuggestions = getTerminalSuggestions("z", [], { cwd: "/tmp/project" });
    const deltaSuggestions = getTerminalSuggestions("git -c", [], { cwd: "/tmp/project" });

    expect(lazyGitSuggestions.map((suggestion) => suggestion.command)).toContain("lazygit");
    expect(lazyDockerSuggestions.map((suggestion) => suggestion.command)).toContain("lazydocker");
    expect(yaziSuggestions.map((suggestion) => suggestion.command)).toContain("yazi");
    expect(zoxideSuggestions.map((suggestion) => suggestion.command)).toContain("z ");
    expect(zoxideSuggestions.map((suggestion) => suggestion.command)).toContain("zi");
    expect(deltaSuggestions.map((suggestion) => suggestion.command)).toContain("git -c core.pager=delta diff");
    expect(deltaSuggestions.map((suggestion) => suggestion.command)).toContain("git -c core.pager=delta diff --staged");
  });

  it("includes matching recent history entries", () => {
    clearTerminalSuggestionCachesForTest();

    const suggestions = getTerminalSuggestions("git s", [
      "git diff",
      "git status",
    ], { cwd: "/tmp/project" });

    expect(suggestions.map((suggestion) => suggestion.command)).toContain("git status");
  });

  it("keeps uncurated history suggestions out of the result set", () => {
    clearTerminalSuggestionCachesForTest();

    const suggestions = getTerminalSuggestions("npm r", [
      "rails server",
      "make dev",
      "npm run dev",
      "npm run test",
    ], { cwd: "/tmp/project" });

    expect(suggestions.map((suggestion) => suggestion.command)).toContain("npm run dev");
    expect(suggestions.map((suggestion) => suggestion.command)).not.toContain("rails server");
    expect(suggestions.map((suggestion) => suggestion.command)).not.toContain("make dev");
  });

  it("keeps history caches isolated per cwd", () => {
    clearTerminalSuggestionCachesForTest();

    const projectOneSuggestions = getTerminalSuggestions("git s", ["git status"], { cwd: "/tmp/project-one" });
    const projectTwoSuggestions = getTerminalSuggestions("git s", ["git stash"], { cwd: "/tmp/project-two" });

    expect(projectOneSuggestions.map((suggestion) => suggestion.command)).toContain("git status");
    expect(projectTwoSuggestions.map((suggestion) => suggestion.command)).toContain("git stash");
  });

  it("returns only the completion remainder for a prefix match", () => {
    expect(getSuggestionRemainder("git ch", "git checkout")).toBe(
      "eckout",
    );
  });
});

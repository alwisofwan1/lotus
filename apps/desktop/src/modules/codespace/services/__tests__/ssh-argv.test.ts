import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { remoteArgv, remoteEnvAssignments, remoteInnerCommand } from "../ssh-argv";

const NASTY = [
  "plain",
  "with space",
  "it's",
  "$HOME",
  "`id`",
  '"double"',
  "back\\slash",
  "semi;colon",
  "pipe|amp&",
  "line1\nline2",
  "--append-system-prompt",
  'You are Rowan. Answer in the house voice; never say "as an AI".',
];

const NUL = String.fromCharCode(0);
const LOGIN_PREFIX = "exec ${SHELL:-bash} -lic ";

/**
 * What the far-side shell actually does with the command we hand it.
 *
 * The point of running a real `/bin/sh` rather than asserting on the quoted string: the string is
 * only evidence, the argv the remote process receives is the claim.
 *
 * It is the *inner* command that is exercised, never the whole ssh line, because the outer wrapper
 * invokes `$SHELL -lic` — running that here would drag in whichever rc files this developer happens
 * to have, and a test whose result depends on someone's `.zshrc` proves nothing about the code.
 */
function argvAfterRemoteShell(innerCommand: string): string[] {
  const out = execFileSync("/bin/sh", ["-c", innerCommand], { encoding: "utf8" });
  return out.split(NUL).slice(0, -1);
}

/** Undo the second layer of quoting the login-shell wrapper adds, exactly as a shell would. */
function unwrapLoginArgument(remoteCommand: string): string {
  const quoted = remoteCommand.slice(remoteCommand.indexOf(LOGIN_PREFIX) + LOGIN_PREFIX.length);
  return execFileSync("/bin/sh", ["-c", `printf '%s' ${quoted}`], { encoding: "utf8" });
}

describe("remoteArgv", () => {
  it("leaves a local command exactly as it was", () => {
    const argv = ["claude", "--resume", "abc", "--model", "opus"];
    expect(remoteArgv({ kind: "local" }, argv)).toEqual(argv);
  });

  it("refuses an empty command instead of producing a broken ssh line", () => {
    expect(() => remoteArgv({ kind: "local" }, [])).toThrow(/needs a command/);
  });

  it("puts the port before the target, like buildSshCommand does", () => {
    const out = remoteArgv({ kind: "ssh", host: "staging", user: "deploy", port: 2222 }, ["ls"]);
    expect(out.slice(0, 5)).toEqual(["ssh", "-t", "-p", "2222", "deploy@staging"]);
  });

  /**
   * Measured against devbox-vps on 2026-09-15: a runner installed by its own installer sits on a
   * PATH that only `.zshrc` sets, so the non-login form reports a present CLI as `command not found`
   * and `-lc` does too (zsh reads `.zprofile` for a login shell). Only `-lic` finds it.
   */
  it("runs the command through a login+interactive shell, or the runner is not on PATH", () => {
    const remote = remoteArgv({ kind: "ssh", host: "h" }, ["claude"]).at(-1) as string;
    expect(remote.startsWith(LOGIN_PREFIX)).toBe(true);
    expect(unwrapLoginArgument(remote)).toBe("exec 'claude'");
  });

  it("execs twice over, so the runner is ssh's own child and closing the pane kills it", () => {
    const remote = remoteArgv({ kind: "ssh", host: "h" }, ["claude"]).at(-1) as string;
    expect(remote.startsWith("exec ")).toBe(true);
    expect(unwrapLoginArgument(remote).startsWith("exec ")).toBe(true);
  });

  it("cds first when a remote folder is given", () => {
    const remote = remoteArgv({ kind: "ssh", host: "h" }, ["claude"], "/srv/devbox/api").at(-1) as string;
    expect(remote.startsWith(`cd '/srv/devbox/api' && ${LOGIN_PREFIX}`)).toBe(true);
  });

  it("rejects a remote folder that is not an absolute path", () => {
    expect(() => remoteArgv({ kind: "ssh", host: "h" }, ["claude"], "srv/api")).toThrow(/absolute/);
  });

  it("delivers every argument to the far side byte for byte", () => {
    expect(argvAfterRemoteShell(remoteInnerCommand(["printf", "%s\\0", ...NASTY]))).toEqual(NASTY);
  });

  it("survives the second layer of quoting the login shell wrapper adds", () => {
    const remote = remoteArgv({ kind: "ssh", host: "h" }, ["printf", "%s\\0", ...NASTY]).at(-1) as string;
    expect(argvAfterRemoteShell(unwrapLoginArgument(remote))).toEqual(NASTY);
  });

  it("survives it through a cd as well", () => {
    const remote = remoteArgv({ kind: "ssh", host: "h" }, ["printf", "%s\\0", ...NASTY], "/tmp").at(-1) as string;
    expect(argvAfterRemoteShell(unwrapLoginArgument(remote))).toEqual(NASTY);
  });

  it("carries a command far past the tty write limit that forced argv in the first place", () => {
    const prompt = "x".repeat(4096);
    const remote = remoteArgv({ kind: "ssh", host: "h" }, ["printf", "%s\\0", prompt]).at(-1) as string;
    expect(argvAfterRemoteShell(unwrapLoginArgument(remote))).toEqual([prompt]);
  });

  it("carries per-session environment in front of the exec", () => {
    const remote = remoteArgv(
      { kind: "ssh", host: "h" },
      ["claude"],
      null,
      { LOTUS_PANE_ID: "canvas:p1", LOTUS_API_PORT: "9877" },
    ).at(-1) as string;
    expect(remote.startsWith("LOTUS_PANE_ID='canvas:p1' LOTUS_API_PORT='9877' exec ")).toBe(true);
  });

  it("keeps the environment ahead of the cd's exec, not the cd", () => {
    const remote = remoteArgv({ kind: "ssh", host: "h" }, ["claude"], "/srv", { A: "1" }).at(-1) as string;
    expect(remote.startsWith("cd '/srv' && A='1' exec ")).toBe(true);
  });
});

describe("remoteEnvAssignments", () => {
  it("is empty when there is nothing to pass", () => {
    expect(remoteEnvAssignments()).toBe("");
    expect(remoteEnvAssignments(null)).toBe("");
    expect(remoteEnvAssignments({})).toBe("");
  });

  it("drops empty and absent values rather than exporting a blank", () => {
    expect(remoteEnvAssignments({ A: "", B: undefined, C: "keep" })).toBe("C='keep' ");
  });

  it("quotes a value that would otherwise break the line", () => {
    const rendered = remoteEnvAssignments({ KEY: "it's $HOME `id`" });
    // Read back from a CHILD's environment: an assignment applies to the command it prefixes, so
    // expanding `$KEY` in this same shell would read the outer one and prove nothing.
    const shown = execFileSync("/bin/sh", ["-c", `${rendered}sh -c 'printf %s "$KEY"'`], {
      encoding: "utf8",
    });
    expect(shown).toBe("it's $HOME `id`");
  });

  /**
   * A shell assignment cannot quote its left-hand side, so a name that is not an identifier has no
   * safe rendering. Refusing beats mangling it into something that runs.
   */
  it("refuses a name that is not a shell identifier", () => {
    expect(() => remoteEnvAssignments({ "BAD NAME": "x" })).toThrow(/shell identifier/);
    expect(() => remoteEnvAssignments({ "A;rm -rf /": "x" })).toThrow(/shell identifier/);
  });
});

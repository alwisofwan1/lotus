import {
  formatSshTarget,
  quoteRemoteShellArg,
  validateRemoteCwd,
  type SshTarget,
} from "./ssh-command";

/** Where a PTY's command runs: this machine, or a machine reached over SSH. */
export type CommandLocation = { kind: "local" } | ({ kind: "ssh" } & SshTarget);

/**
 * Carry an argv across SSH without letting the remote shell re-read it.
 *
 * **Two rules of this codebase meet here, pulling opposite ways, and the whole reason this is one
 * tested function is so they meet in exactly one place.**
 *
 * 1. *A long command must not be typed into a tty.* Measured 2026-09-12: a pty in the non-canonical
 *    mode a shell's line editor puts it in accepts ~1022 bytes per write; past that the line
 *    discipline rings the bell and DISCARDS every further character, so the closing quote never
 *    lands and no CLI ever starts. That is why a resume command rides argv
 *    (`services/live-agent-spawn.ts`, `plans/codecanvas-session-refactor/issues/08`).
 * 2. *An argv never passes through a shell.* `portable_pty` hands tokens to the child verbatim, so a
 *    system prompt is ONE element and needs no quoting (`lib/agent-runtime/spawn-argv.ts`).
 *
 * `ssh host <command>` hands `<command>` to a shell on the far side, which undoes rule 2: every
 * element that was safe raw is suddenly shell input again. So each one is single-quoted here, once,
 * with the quoter `ssh-command.ts` already owns — and `exec` is used so the runner replaces that
 * shell rather than sitting under it, which is what lets closing the pane actually kill the runner.
 *
 * Length is deliberately NOT a concern on this path: these bytes are `ssh`'s own argv, not keystrokes
 * into a tty, so rule 1 never applies to them.
 *
 * **And the command runs under a login+interactive shell, which is not decoration either.** Measured
 * against `devbox-vps` on 2026-09-15, asking for `claude` three ways:
 *
 * | How | Answer |
 * |---|---|
 * | plain `ssh host 'claude'` (non-login) | `command not found` — PATH lacks `~/.local/bin` |
 * | `${SHELL:-bash} -lc` | still not found: zsh reads `.zprofile` when it is a login shell |
 * | `${SHELL:-bash} -lic` | `/home/alwi/.local/bin/claude` |
 *
 * A runner installed by its own installer lives on a PATH that only the operator's `.zshrc` sets, so
 * the non-login form reports a perfectly present CLI as missing. `buildSshCommand` already used
 * `-lic` for the shell path; this is the argv path catching up.
 */
export function remoteArgv(
  location: CommandLocation,
  argv: readonly string[],
  remoteCwd?: string | null,
  env?: Readonly<Record<string, string | undefined>> | null,
): string[] {
  if (argv.length === 0) {
    throw new Error("remoteArgv needs a command; use buildSshCommand for a bare login shell.");
  }
  if (location.kind === "local") {
    return [...argv];
  }

  const args = ["ssh", "-t"];
  const port = location.port ?? undefined;
  if (port !== undefined) {
    args.push("-p", String(port));
  }
  args.push(formatSshTarget(location));

  const cwd = remoteCwd ? validateRemoteCwd(remoteCwd) : "";
  const assignments = remoteEnvAssignments(env);
  const login = `${assignments}exec \${SHELL:-bash} -lic ${quoteRemoteShellArg(remoteInnerCommand(argv))}`;
  args.push(cwd ? `cd ${quoteRemoteShellArg(cwd)} && ${login}` : login);
  return args;
}

/**
 * The command the remote login shell runs: `exec` plus the argv, each element quoted once.
 *
 * `exec` twice over (here and in the login-shell wrapper) is deliberate — each one *replaces* its
 * shell rather than forking under it, so the runner ends up as the direct child of `ssh` and closing
 * the pane still kills it.
 */
export function remoteInnerCommand(argv: readonly string[]): string {
  return `exec ${argv.map(quoteRemoteShellArg).join(" ")}`;
}

/**
 * Environment the remote process is started with, as shell assignments.
 *
 * **Why the command line and not the remote's disk.** A hook on the far machine has to know which
 * pane it belongs to and how to reach this desktop, and both are per-session facts: writing them to
 * a file on someone else's VPS leaves a credential lying around after the session ends. An
 * assignment in front of `exec` lives exactly as long as the process does.
 *
 * It is not invisible: while the remote shell is still the shell, the assignment is in its command
 * line and another process of the **same user** can read it with `ps`. After `exec` it is only in
 * the process environment. That is the trade — the alternative, `SendEnv`, needs `AcceptEnv` in the
 * machine's sshd config, which is not ours to require.
 *
 * Names are validated rather than escaped: a shell assignment cannot quote its left-hand side, so
 * anything that is not a plain identifier has no safe rendering and is refused instead of mangled.
 */
export function remoteEnvAssignments(
  env?: Readonly<Record<string, string | undefined>> | null,
): string {
  if (!env) return "";
  const parts: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || value === null || value === "") continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Environment name is not a shell identifier: ${name}`);
    }
    parts.push(`${name}=${quoteRemoteShellArg(value)}`);
  }
  return parts.length > 0 ? `${parts.join(" ")} ` : "";
}

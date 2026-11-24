export type SshTarget = {
  host: string;
  user?: string | null;
  port?: number | null;
};

export type SshCommandOptions = {
  target: SshTarget;
  remoteCwd?: string | null;
  initialCommand?: string | null;
};

const HOST_PATTERN = /^[A-Za-z0-9._-]+$/;
const USER_PATTERN = /^[A-Za-z0-9._-]+$/;
const UNSAFE_REMOTE_PATH_CHARS = /[\u0000-\u001f;&|`]/;
const UNSAFE_REMOTE_COMMAND_CHARS = /[\u0000-\u001f]/;

export function formatSshTarget(target: SshTarget): string {
  const host = target.host.trim();
  const user = target.user?.trim();
  const port = target.port ?? undefined;

  if (!HOST_PATTERN.test(host)) {
    throw new Error("SSH host must be a config alias or hostname.");
  }

  if (user && !USER_PATTERN.test(user)) {
    throw new Error("SSH user contains unsupported characters.");
  }

  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("SSH port must be between 1 and 65535.");
  }

  return user ? `${user}@${host}` : host;
}

export function quoteRemoteShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function validateRemoteCwd(remoteCwd: string): string {
  const trimmed = remoteCwd.trim();
  if (!trimmed.startsWith("/")) {
    throw new Error("Remote folder must be an absolute path.");
  }
  if (UNSAFE_REMOTE_PATH_CHARS.test(trimmed) || trimmed.includes("$(")) {
    throw new Error("Remote folder contains unsupported shell characters.");
  }
  return trimmed;
}

export function validateRemoteInitialCommand(command: string): string {
  const trimmed = command.trim();
  if (UNSAFE_REMOTE_COMMAND_CHARS.test(trimmed)) {
    throw new Error("Remote command contains unsupported control characters.");
  }
  return trimmed;
}

function buildRemoteLoginShellCommand(command: string): string {
  return `exec \${SHELL:-bash} -lic ${quoteRemoteShellArg(command)}`;
}

// The remote shell has no Lotus shell integration, so the pane is told by hand that the command
// has handed the terminal back: the same OSC 133;D a local prompt prints (fleet-output-tap.ts).
const COMMAND_DONE_MARK = 'printf "\\033]133;D\\007"';

// zsh reads $ZDOTDIR/.zshenv first; this one points ZDOTDIR back, deletes its own folder, and
// leaves the user's startup files to load as they always do — plus a precmd that prints the mark.
const ZSHENV = [
  'ZDOTDIR=$LOTUS_ORIGINAL_ZDOTDIR; rm -rf "$LOTUS_RC_DIR"; unset LOTUS_ORIGINAL_ZDOTDIR LOTUS_RC_DIR',
  '[[ -r $ZDOTDIR/.zshenv ]] && source $ZDOTDIR/.zshenv',
  `if [[ -o interactive ]]; then __lotus_done() { ${COMMAND_DONE_MARK}; }; autoload -Uz add-zsh-hook && add-zsh-hook precmd __lotus_done; fi`,
].join("\n");

// bash has no ZDOTDIR: an --rcfile shell does a login's reading by hand, then adds the mark.
const BASHRC = [
  'rm -rf "$LOTUS_RC_DIR"; unset LOTUS_RC_DIR',
  "[ -r /etc/profile ] && . /etc/profile",
  'for f in ~/.bash_profile ~/.bash_login ~/.profile; do [ -r "$f" ] && { . "$f"; break; }; done',
  `PROMPT_COMMAND='${COMMAND_DONE_MARK}'\${PROMPT_COMMAND:+";$PROMPT_COMMAND"}`,
].join("\n");

// fish reads its own config first; -C then adds the hook, so nothing is written (as the local
// integration does it, src-tauri/src/pty/shell_integration.rs).
const FISH_INIT = "function __lotus_done --on-event fish_prompt; printf '\\e]133;D\\a'; end";

// A POSIX sh (dash, ksh, sh) has no prompt hook, but prints PS1 at every prompt and reads $ENV
// last; so the mark goes in front of PS1, after the user's own $ENV has run.
const SH_ENV = [
  'rm -rf "$LOTUS_RC_DIR"; ENV=$LOTUS_ORIGINAL_ENV; unset LOTUS_RC_DIR LOTUS_ORIGINAL_ENV',
  '[ -n "$ENV" ] && [ -r "$ENV" ] && . "$ENV"',
  `PS1="$(${COMMAND_DONE_MARK})\${PS1-\$ }"`,
].join("\n");

/**
 * The remote login shell, with just enough shell integration to print OSC 133;D at every prompt,
 * so an agent typed by hand into an SSH pane is seen exiting too. Nothing is installed on the
 * machine: the rc lives in a `mktemp -d` folder that deletes itself as soon as the shell reads it.
 * Any other shell (tcsh, nushell), or no mktemp, gets the plain login shell as before.
 */
export const REMOTE_LOGIN_SHELL = [
  `d=$(mktemp -d 2>/dev/null) && case \${SHELL:-sh} in`,
  `*zsh) printf '%s\\n' ${quoteRemoteShellArg(ZSHENV)} > "$d/.zshenv" && LOTUS_ORIGINAL_ZDOTDIR=\${ZDOTDIR:-$HOME} LOTUS_RC_DIR=$d ZDOTDIR=$d exec "$SHELL" -l;;`,
  `*bash) printf '%s\\n' ${quoteRemoteShellArg(BASHRC)} > "$d/rc" && LOTUS_RC_DIR=$d exec "$SHELL" --rcfile "$d/rc" -i;;`,
  `*fish) rm -rf "$d"; exec "$SHELL" -l -C ${quoteRemoteShellArg(FISH_INIT)};;`,
  `*/sh|*/dash|*/ksh|*/mksh|*/ash) printf '%s\\n' ${quoteRemoteShellArg(SH_ENV)} > "$d/env" && LOTUS_ORIGINAL_ENV=$ENV LOTUS_RC_DIR=$d ENV=$d/env exec "$SHELL" -l;;`,
  `esac; [ -n "$d" ] && rm -rf "$d"; exec \${SHELL:-sh} -l`,
].join(" ");

function buildRemoteInitialCommand(command: string): string {
  return buildRemoteLoginShellCommand(`${command}; ${COMMAND_DONE_MARK}; ${REMOTE_LOGIN_SHELL}`);
}

export function buildSshCommand({ target, remoteCwd, initialCommand }: SshCommandOptions): string[] {
  const args = ["ssh", "-t"];
  const port = target.port ?? undefined;
  if (port !== undefined) {
    args.push("-p", String(port));
  }
  args.push(formatSshTarget(target));

  const command = validateRemoteInitialCommand(initialCommand ?? "");
  const cwd = remoteCwd ? validateRemoteCwd(remoteCwd) : "";
  const remoteParts: string[] = [];
  if (cwd) {
    remoteParts.push(`cd ${quoteRemoteShellArg(cwd)}`);
  }
  remoteParts.push(command ? buildRemoteInitialCommand(command) : REMOTE_LOGIN_SHELL);
  args.push(remoteParts.join(" && "));
  return args;
}

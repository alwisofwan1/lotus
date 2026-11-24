if [ -z "${LOTUS_SHELL_INTEGRATION:-}" ]; then
  return 0 2>/dev/null || exit 0
fi

if [ -z "${LOTUS_BASH_USER_STARTUP_SOURCED:-}" ]; then
  export LOTUS_BASH_USER_STARTUP_SOURCED=1
  for lotus_startup in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
    if [ -r "$lotus_startup" ]; then
      . "$lotus_startup"
      break
    fi
  done
  if [ -r "$HOME/.bashrc" ]; then
    . "$HOME/.bashrc"
  fi
fi

__lotus_emit_cwd() {
  printf '\033]7;file://%s%s\007' "${HOSTNAME:-localhost}" "$PWD"
  printf '\033]777;lotus-cwd=%s\007' "$PWD"
}

__lotus_prompt_command() {
  local status=$?
  printf '\033]133;D;%s\007' "$status"
  __lotus_emit_cwd
  printf '\033]133;A\007'
}

__lotus_preexec() {
  printf '\033]133;B\007\033]133;C\007'
}

case ";${PROMPT_COMMAND:-};" in
  *";__lotus_prompt_command;"*) ;;
  *) PROMPT_COMMAND="__lotus_prompt_command${PROMPT_COMMAND:+;$PROMPT_COMMAND}" ;;
esac

trap '__lotus_preexec' DEBUG
__lotus_emit_cwd

# Codex 0.162 runs turns, and so its hooks, in one shared background server that carries the
# env of whichever pane started it; every Codex pane's hook reports then name that one pane, and
# Lotus never learns this pane's transcript or activity (2026-10-10). `--no-daemon` keeps the
# server inside this pane's process. Only the interactive screen (no subcommand, options only,
# `resume`, `fork`) gets it: the other subcommands either do not take it or are not a session.
# A `codex` the user already aliased or wrapped is left alone.
__lotus_codex() {
  case "${1-}" in
    agents|exec|e|review|login|logout|mcp|mcp-server|plugin|app-server|remote-control|app|completion|update|doctor|sandbox|debug|apply|queue|archive|delete|migrate-rollouts|unarchive|cloud|exec-server|features|help)
      command codex "$@" ;;
    *)
      case " $* " in
        *" --no-daemon "*|*" --remote "*|*" --remote="*) command codex "$@" ;;
        *) command codex --no-daemon "$@" ;;
      esac ;;
  esac
}
case "$(type -t codex 2>/dev/null)" in
  file|"") codex() { __lotus_codex "$@"; } ;;
esac

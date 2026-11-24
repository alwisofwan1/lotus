if [[ -z "${LOTUS_SHELL_INTEGRATION:-}" ]]; then
  return 0 2>/dev/null || exit 0
fi

if [[ -z "${LOTUS_ZSHRC_SOURCED:-}" ]]; then
  LOTUS_ZSHRC_SOURCED=1
  lotus_original_file="$LOTUS_ORIGINAL_ZDOTDIR/.zshrc"
  lotus_integration_file="$ZDOTDIR/.zshrc"
  if [[ -n "${LOTUS_ORIGINAL_ZDOTDIR:-}" && -r "$lotus_original_file" ]]; then
    if [[ ! -e "$lotus_integration_file" || ! "$lotus_original_file" -ef "$lotus_integration_file" ]]; then
      source "$lotus_original_file"
    fi
  fi
  unset lotus_original_file lotus_integration_file
fi

# zsh prints PROMPT_EOL_MARK (default "%") before the first prompt when a
# startup hook emits non-newline terminal control sequences. Lotus emits OSC
# CWD markers before the prompt, so disable the visual marker for cleaner panes.
PROMPT_EOL_MARK=""

__lotus_percent_encode_path() {
  local input="$1"
  local encoded=""
  local char hex
  local i
  local LC_ALL=C
  for (( i = 0; i < ${#input}; i++ )); do
    char="${input[$((i + 1))]}"
    case "$char" in
      [A-Za-z0-9/._~-])
        encoded+="$char"
        ;;
      *)
        printf -v hex '%%%02X' "'$char"
        encoded+="$hex"
        ;;
    esac
  done
  printf '%s' "$encoded"
}

__lotus_emit_cwd() {
  printf '\033]7;file://%s%s\007' "${HOST:-localhost}" "$(__lotus_percent_encode_path "$PWD")"
  printf '\033]777;lotus-cwd=%s\007' "$PWD"
}

__lotus_precmd() {
  local lotus_status=$?
  printf '\033]133;D;%s\007' "$lotus_status"
  __lotus_emit_cwd
  printf '\033]133;A\007'
}

__lotus_preexec() {
  printf '\033]133;B\007\033]133;C\007'
}

if autoload -Uz add-zsh-hook 2>/dev/null; then
  add-zsh-hook precmd __lotus_precmd
  add-zsh-hook preexec __lotus_preexec
else
  precmd_functions+=(__lotus_precmd)
  preexec_functions+=(__lotus_preexec)
fi

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
case "$(whence -w codex 2>/dev/null)" in
  *": command"|*": none"|"") codex() { __lotus_codex "$@"; } ;;
esac

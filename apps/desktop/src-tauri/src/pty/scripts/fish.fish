if not set -q LOTUS_SHELL_INTEGRATION
    return 0
end

function __lotus_emit_cwd
    printf '\e]7;file://%s%s\a' (hostname) "$PWD"
    printf '\e]777;lotus-cwd=%s\a' "$PWD"
end

function __lotus_prompt --on-event fish_prompt
    printf '\e]133;A\a'
    __lotus_emit_cwd
end

function __lotus_preexec --on-event fish_preexec
    printf '\e]133;B\a\e]133;C\a'
end

function __lotus_postexec --on-event fish_postexec
    printf '\e]133;D;%s\a' $status
end

__lotus_emit_cwd

# Codex 0.162 runs turns, and so its hooks, in one shared background server that carries the
# env of whichever pane started it; every Codex pane's hook reports then name that one pane, and
# Lotus never learns this pane's transcript or activity (2026-10-10). `--no-daemon` keeps the
# server inside this pane's process. Only the interactive screen (no subcommand, options only,
# `resume`, `fork`) gets it: the other subcommands either do not take it or are not a session.
# A `codex` the user already aliased or wrapped is left alone.
if not functions -q codex; and not abbr -q codex 2>/dev/null
    function codex --wraps codex
        switch "$argv[1]"
            case agents exec e review login logout mcp mcp-server plugin app-server remote-control app completion update doctor sandbox debug apply queue archive delete migrate-rollouts unarchive cloud exec-server features help
                command codex $argv
            case '*'
                if contains -- --no-daemon $argv; or contains -- --remote $argv; or string match -q -- '--remote=*' $argv
                    command codex $argv
                else
                    command codex --no-daemon $argv
                end
        end
    end
end

#!/usr/bin/env bash
#
# Standalone Host — VPS installer.
#
# Two jobs, in this order: refuse to install a host that will fail silently, then
# install one and prove it answers. Every refusal prints the CONSEQUENCE, not just the
# missing thing — an operator reading "codex not found" learns nothing about the phone
# that will fail every spawn.
#
#   ./install.sh --env-file /etc/lotus-host.env
#   ./install.sh --preflight-only            # check this machine, change nothing
#
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ENV_FILE="/etc/lotus-host.env"
UNIT_PATH="/etc/systemd/system/lotus-host.service"
BIN_PATH="/usr/local/bin/lotus-host"
RUN_USER="${SUDO_USER:-$(id -un)}"
BINARY=""
DIST_DIR=""
LOGIN_PATH=""
PREFLIGHT_ONLY=0
PRINT_UNIT=0
FAILED=0

usage() {
  cat <<'USAGE'
usage: install.sh [options]

  --env-file PATH     environment file to install and point the unit at
                      (default: /etc/lotus-host.env)
  --user NAME         user the host runs as (default: $SUDO_USER, else you)
  --binary PATH       compiled host to install at /usr/local/bin/lotus-host.
                      Omitted: looks for lotus-remote-bin in --dist-dir, then falls
                      back to running the source tree under bun.
  --dist-dir PATH     where to look for a build (default: ../dist)
  --login-path PATH   PATH used to look for claude/codex/tmux instead of asking the
                      run user's login shell. For hosts whose login shell is not
                      bash, and for the tests.
  --preflight-only    run the checks and stop. Changes nothing.
  --print-unit        render the systemd unit to stdout and stop. Changes nothing.
  -h, --help          this
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)   ENV_FILE="$2"; shift 2 ;;
    --user)       RUN_USER="$2"; shift 2 ;;
    --binary)     BINARY="$2"; shift 2 ;;
    --dist-dir)   DIST_DIR="$2"; shift 2 ;;
    --login-path) LOGIN_PATH="$2"; shift 2 ;;
    --preflight-only) PREFLIGHT_ONLY=1; shift ;;
    --print-unit) PRINT_UNIT=1; PREFLIGHT_ONLY=0; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ── Output ──────────────────────────────────────────────────────────────────────
# `fail` records and keeps going. One run should report everything wrong with the
# machine, not send the operator around the loop once per problem.

# With --print-unit the unit is the output, so the chatter moves to stderr and
# `install.sh --print-unit > lotus-host.service` produces a file that is only the unit.
say()  { if [[ "$PRINT_UNIT" -eq 1 ]]; then printf '%s\n' "$*" >&2; else printf '%s\n' "$*"; fi; }
info() { say "  $*"; }
ok()   { say "  ok    $*"; }
warn() { printf '  WARN  %s\n' "$*" >&2; }
fail() { printf '  FAIL  %s\n' "$*" >&2; FAILED=1; }

# ── Probes ──────────────────────────────────────────────────────────────────────

# Login PATH, not this script's PATH. bun, claude and codex install into ~/.bun/bin
# and ~/.local/bin, which a non-login shell does not have — the 2026-08-30 preflight
# reported claude and bun "missing" on a box that had both.
login_path() {
  if [[ -n "$LOGIN_PATH" ]]; then printf '%s' "$LOGIN_PATH"; return; fi
  if [[ "$RUN_USER" == "$(id -un)" ]]; then
    bash -lc 'printf %s "$PATH"' 2>/dev/null || printf '%s' "$PATH"
  else
    sudo -u "$RUN_USER" bash -lc 'printf %s "$PATH"' 2>/dev/null || printf '%s' "$PATH"
  fi
}

# Resolved once: each call would otherwise start a login shell.
RESOLVED_LOGIN_PATH=""
have() {
  [[ -n "$RESOLVED_LOGIN_PATH" ]] || RESOLVED_LOGIN_PATH="$(login_path)"
  PATH="$RESOLVED_LOGIN_PATH" command -v "$1" >/dev/null 2>&1
}
have_path() {
  [[ -n "$RESOLVED_LOGIN_PATH" ]] || RESOLVED_LOGIN_PATH="$(login_path)"
  PATH="$RESOLVED_LOGIN_PATH" command -v "$1" 2>/dev/null
}

# Reads one key out of the env file. Not `source`: that file is systemd syntax, and
# sourcing it would execute whatever a stray backtick happens to be.
env_value() {
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -n1 | sed 's/[[:space:]]*$//'
}

# ── Preflight ───────────────────────────────────────────────────────────────────

say "Preflight (user: $RUN_USER, env: $ENV_FILE)"

# Sessions live in lotus-sessiond, embedded in the binary (ADR-0067): nothing to install.
# A host from before kept its agents in tmux as `lotus-*`, and the new one does not see them —
# they keep running, unreachable from the phone. Not fatal: finishing them is the operator's call.
if have tmux; then
  if [[ "$RUN_USER" == "$(id -un)" ]]; then
    old_sessions="$(PATH="$RESOLVED_LOGIN_PATH" tmux ls -F '#{session_name}' 2>/dev/null | grep -c '^lotus-' || true)"
  else
    old_sessions="$(sudo -u "$RUN_USER" env PATH="$RESOLVED_LOGIN_PATH" tmux ls -F '#{session_name}' 2>/dev/null | grep -c '^lotus-' || true)"
  fi
  if [[ "${old_sessions:-0}" -gt 0 ]]; then
    warn "$old_sessions agent session(s) still run in tmux (lotus-*) from the previous host. \
The new host cannot see them: finish or stop them first (tmux ls | grep '^lotus-')."
  fi
fi

# Runners — none is fatal, one is a warning. A host with claude and no codex is a
# useful host that simply does not advertise structured-spawn.
# Runs it, rather than only finding it. A runner on PATH can still be unrunnable — a JS
# CLI whose `#!/usr/bin/env node` points at a node the service never sees is the case that
# cost an evening: `command -v codex` said yes, every spawn died with "app-server closed
# its output", and the host looked healthy throughout.
runs() {
  local out
  if out=$(PATH="$RESOLVED_LOGIN_PATH" "$1" --version 2>&1); then return 0; fi
  BROKEN_REASON="$(printf '%s' "$out" | head -n1)"
  return 1
}

RUNNERS=()
BROKEN=()
BROKEN_REASON=""
for runner in claude codex; do
  have "$runner" || continue
  if runs "$runner"; then
    RUNNERS+=("$runner")
  else
    BROKEN+=("$runner")
    warn "$runner is on the PATH but does not run: ${BROKEN_REASON}. It will fail every \
spawn while the host reports itself healthy. Point it at a binary this service can execute, \
or put what it needs on the PATH."
  fi
done
if [[ ${#RUNNERS[@]} -eq 0 ]]; then
  fail "neither claude nor codex can run as ${RUN_USER}. The host would start \
and accept a phone, then fail every spawn — a host that looks healthy and can do nothing."
else
  ok "runners: ${RUNNERS[*]}"
  if [[ ! " ${RUNNERS[*]} " == *" codex "* ]]; then
    warn "codex is missing. The host still works; it will not advertise structured-spawn, \
so the phone loses permission, transcript and Chat on this host (STRUCTURED_FEATURES)."
  fi
  if [[ ! " ${RUNNERS[*]} " == *" claude "* ]]; then
    warn "claude is missing. Cells that ask for it will fail to spawn."
  fi
fi

# Env file
if [[ -f "$ENV_FILE" ]]; then
  ok "env file $ENV_FILE"
else
  fail "no env file at $ENV_FILE. Copy $DEPLOY_DIR/.env.vps.example there, edit it, \
chmod 600, and run this again."
fi

MODE="$(env_value LOTUS_MODE)"
[[ "$MODE" == "standalone" ]] \
  || fail "LOTUS_MODE is '${MODE:-unset}', not 'standalone'. The host would try to reach \
a Lotus desktop app that does not exist on this machine."

BIND="$(env_value LOTUS_MOBILE_BIND)"
case "$BIND" in
  0.0.0.0:*|::*|"[::]":*)
    fail "LOTUS_MOBILE_BIND is $BIND — that publishes the façade on every interface. \
ADR-C: this host is reached through the private path the machine already has, and \
device tokens are authorisation, not a substitute for not being on the internet." ;;
  "") warn "LOTUS_MOBILE_BIND unset; defaulting to 127.0.0.1:8787." ;;
  *)  ok "bind $BIND" ;;
esac

ADMIN_SECRET="$(env_value LOTUS_MOBILE_ADMIN_SECRET)"
if [[ -z "$ADMIN_SECRET" ]]; then
  if [[ "$PREFLIGHT_ONLY" -eq 1 ]]; then
    warn "LOTUS_MOBILE_ADMIN_SECRET is empty. Without it the adapter starts with no admin \
surface at all — no /admin/health to check, and no way to mint a pairing code. \
An install run generates one; this preflight-only run leaves the file alone."
  else
    info "generating LOTUS_MOBILE_ADMIN_SECRET (was empty)"
    ADMIN_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
else
  ok "admin secret set"
fi

# FCM — set-but-unreadable is a misconfiguration the operator meant to work, so it is
# fatal. Unset is a choice, so it is a warning that names what it costs.
FCM="$(env_value LOTUS_FCM_SERVICE_ACCOUNT)"
if [[ -n "$FCM" ]]; then
  if sudo -u "$RUN_USER" test -r "$FCM" 2>/dev/null || { [[ "$RUN_USER" == "$(id -un)" ]] && [[ -r "$FCM" ]]; }; then
    ok "FCM service account readable by $RUN_USER"
  else
    fail "LOTUS_FCM_SERVICE_ACCOUNT points at $FCM, which $RUN_USER cannot read. \
Push would be off while the config says it is on — approvals would wait on this machine \
with nothing ringing."
  fi
else
  warn "LOTUS_FCM_SERVICE_ACCOUNT unset. This host cannot wake a backgrounded phone, so \
an agent waiting for approval is silent and looks like a host where nothing is happening. \
Copy ~/.lotus/fcm-service-account.json from the desktop machine."
fi

# Runtime: the compiled artifact if there is one, otherwise bun on the source tree.
EXEC_START=""
DIST_DIR="${DIST_DIR:-$DEPLOY_DIR/../dist}"
[[ -n "$BINARY" ]] || { [[ -f "$DIST_DIR/lotus-remote-bin" ]] && BINARY="$DIST_DIR/lotus-remote-bin"; }
if [[ -n "$BINARY" && -f "$BINARY" ]]; then
  ok "runtime: compiled binary $BINARY"
  EXEC_START="$BIN_PATH"
else
  BUN=""
  for candidate in "$(have_path bun)" "/home/$RUN_USER/.bun/bin/bun" "/usr/local/bin/bun" "/opt/bun/bin/bun"; do
    [[ -n "$candidate" && -x "$candidate" ]] && { BUN="$candidate"; break; }
  done
  if [[ -n "$BUN" ]]; then
    ok "runtime: $BUN on the source tree at $DEPLOY_DIR/.."
    EXEC_START="$BUN run $DEPLOY_DIR/../src/index.ts"
  else
    fail "no compiled host given and no bun found. Build one with \
'bun build src/index.ts --compile --target=bun-linux-x64 --outfile dist/lotus-remote-bin' \
on any machine and copy it here, or install bun."
  fi
fi

# The PATH the unit will run with. Systemd gives a service `/usr/local/sbin:/usr/local/bin:
# /usr/sbin:/usr/bin` and nothing else, so a host installed without this cannot see runners
# that live under the operator's home — which is where both of them live.
RUN_PATH="${RESOLVED_LOGIN_PATH:-$(login_path)}"

render_unit() {
  sed -e "s|__RUN_USER__|$RUN_USER|g" \
      -e "s|__RUN_GROUP__|$(id -gn "$RUN_USER")|g" \
      -e "s|__RUN_HOME__|$(getent passwd "$RUN_USER" | cut -d: -f6)|g" \
      -e "s|__RUN_PATH__|$RUN_PATH|g" \
      -e "s|__ENV_FILE__|$ENV_FILE|g" \
      -e "s|__EXEC_START__|$EXEC_START|g" \
      "$DEPLOY_DIR/lotus-host.service"
}

if [[ "$PRINT_UNIT" -eq 1 ]]; then
  render_unit
  exit 0
fi

if [[ "$FAILED" -eq 1 ]]; then
  echo "Preflight failed — nothing was installed." >&2
  exit 1
fi
say "Preflight passed."
[[ "$PREFLIGHT_ONLY" -eq 1 ]] && exit 0

# ── Install ─────────────────────────────────────────────────────────────────────

RUN_GROUP="$(id -gn "$RUN_USER")"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
: "${RUN_HOME:?cannot resolve home directory for $RUN_USER}"

echo "Installing"

if [[ -n "$BINARY" && -f "$BINARY" ]]; then
  # Re-running against the already-installed binary is the normal way to re-render the unit
  # after editing this script; `install` refuses same-file and would abort the whole run.
  if [[ "$(readlink -f "$BINARY")" == "$(readlink -f "$BIN_PATH")" ]]; then
    ok "$BIN_PATH (already installed)"
  else
    sudo install -m 0755 "$BINARY" "$BIN_PATH"
    ok "$BIN_PATH"
  fi
fi

# The admin secret is a credential, so the file it lands in is 0600 and owned by the
# user that reads it — not world-readable under /etc like most unit environment files.
if ! grep -q '^LOTUS_MOBILE_ADMIN_SECRET=' "$ENV_FILE"; then
  printf '\nLOTUS_MOBILE_ADMIN_SECRET=%s\n' "$ADMIN_SECRET" | sudo tee -a "$ENV_FILE" >/dev/null
elif [[ -z "$(env_value LOTUS_MOBILE_ADMIN_SECRET)" ]]; then
  sudo sed -i "s|^LOTUS_MOBILE_ADMIN_SECRET=.*|LOTUS_MOBILE_ADMIN_SECRET=$ADMIN_SECRET|" "$ENV_FILE"
fi
sudo chown "$RUN_USER:$RUN_GROUP" "$ENV_FILE"
sudo chmod 600 "$ENV_FILE"
ok "$ENV_FILE (0600 $RUN_USER:$RUN_GROUP)"

render_unit | sudo tee "$UNIT_PATH" >/dev/null
ok "$UNIT_PATH"

sudo systemctl daemon-reload
sudo systemctl enable lotus-host >/dev/null 2>&1
# `enable --now` starts only a unit that is stopped, so re-running this script against a
# live host rewrote the unit and left the old process running under the old one — the
# install reported success and nothing it had just changed was in effect. Restart says what
# is meant: whatever was running, run the thing this script just wrote.
sudo systemctl restart lotus-host
ok "lotus-host enabled and (re)started"

# ── Verify ──────────────────────────────────────────────────────────────────────
#
# `systemctl is-active` proves a process exists, which is not the claim being made.
# The claim is that a phone could talk to this host, so ask the host.

STATE_DIR="$(env_value LOTUS_STATE_DIR)"; STATE_DIR="${STATE_DIR:-$RUN_HOME/.lotus}"
ADVERT="$STATE_DIR/mobile-admin.json"
ADMIN_SECRET="$(env_value LOTUS_MOBILE_ADMIN_SECRET)"

echo "Verifying"
for _ in $(seq 1 20); do
  [[ -f "$ADVERT" ]] && break
  sleep 0.5
done

if [[ ! -f "$ADVERT" ]]; then
  fail "the host did not advertise its admin port at $ADVERT within 10s. \
Read why: journalctl -u lotus-host -n 50"
  exit 1
fi

ADMIN_PORT="$(sudo sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$ADVERT" | head -n1)"
HEALTH="$(curl -fsS -H "Authorization: Bearer $ADMIN_SECRET" \
  "http://127.0.0.1:$ADMIN_PORT/admin/health" 2>/dev/null || true)"

if [[ -z "$HEALTH" ]]; then
  fail "/admin/health did not answer on port $ADMIN_PORT. journalctl -u lotus-host -n 50"
  exit 1
fi

ok "/admin/health: $HEALTH"
case "$HEALTH" in
  *'"mobile":null'*)
    warn "the façade is not bound. The host is up and no phone can reach it — \
check LOTUS_MOBILE_BIND." ;;
esac

cat <<NEXT

Next:
  journalctl -u lotus-host -f                       watch it
  bash $DEPLOY_DIR/pair.sh --env-file $ENV_FILE     pair a phone (QR + code)

Reaching it from outside is deliberately not this script's job (ADR-C): point the
private path this machine already has — on devbox-vps, a Cloudflare Tunnel route —
at ${BIND:-127.0.0.1:8787}, with no Access application in front of it (issues/07).
NEXT

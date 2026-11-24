# Managed Host steps, run on the SSH machine as `sh -c "$THIS" lotus-host <step> [version|name]`.
# User mode only: everything lives in ~/.lotus/host, nothing needs root (plans/managed-host/PLAN.md).
set -u
D="$HOME/.lotus/host"
STEP="${1:-}"
ARG="${2:-}"
ADVERT="$HOME/.lotus/mobile-admin.json"
UNIT="$HOME/.config/systemd/user/lotus-host.service"
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) ARCH="" ;;
esac
[ "$(uname -s)" = Linux ] || ARCH=""

fail() { printf '%s\n' "$*" >&2; exit 1; }
user_systemd() { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; }
# Without linger the user manager, and every unit in it, stops at logout: then a detached process is
# what outlives the SSH session.
lingers() { user_systemd && loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q '=yes'; }
fetch() { # url file
  if command -v curl >/dev/null 2>&1; then curl -fsSL --max-time 600 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -T 600 -O "$2" "$1"
  else return 1; fi
}
get() { # url -> stdout
  if command -v curl >/dev/null 2>&1; then curl -fsS -m 5 ${3:+-H "$3"} "$1"
  else wget -q -T 5 -O - ${3:+--header="$3"} "$1"; fi
}
pid_alive() { [ -f "$D/pid" ] && ps -p "$(cat "$D/pid")" -o args= 2>/dev/null | grep -q '.lotus/host/lotus-host'; }
running() {
  if [ -f "$UNIT" ] && user_systemd; then systemctl --user is-active --quiet lotus-host; else pid_alive; fi
}
stop_host() {
  [ -f "$UNIT" ] && user_systemd && systemctl --user stop lotus-host 2>/dev/null
  if pid_alive; then kill "$(cat "$D/pid")" 2>/dev/null; fi
  rm -f "$D/pid"
}
log_tail() {
  if [ -f "$UNIT" ] && user_systemd; then journalctl --user -u lotus-host -n 20 --no-pager 2>/dev/null
  else tail -n 20 "$D/host.log" 2>/dev/null; fi
}
# Health answers with the build the binary was stamped with; a release stamps the app version.
health() { # admin secret -> body
  port=$(sed -n 's/.*"port"[ ]*:[ ]*\([0-9][0-9]*\).*/\1/p' "$ADVERT" 2>/dev/null | head -n 1)
  [ -n "$port" ] && get "http://127.0.0.1:$port/admin/health" "" "Authorization: Bearer $1"
}

start_host() {
  [ -x "$D/lotus-host" ] || fail "The host is not installed."
  stop_host
  rm -f "$ADVERT"
  # A non-login SSH shell has a bare PATH; the agents the host spawns live on the login one.
  lp=$("${SHELL:-sh}" -lc 'printf %s "$PATH"' 2>/dev/null) || lp="$PATH"
  [ -n "$lp" ] || lp="$PATH"
  if lingers; then
    mkdir -p "$(dirname "$UNIT")"
    # KillMode=process: a restart stops the host only; lotus-sessiond and its sessions stay.
    cat >"$UNIT" <<EOF
[Unit]
Description=Lotus host (installed by Lotus)

[Service]
ExecStart=%h/.lotus/host/lotus-host
WorkingDirectory=%h
EnvironmentFile=%h/.lotus/host/env
Environment="PATH=$lp"
KillMode=process
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload && systemctl --user enable lotus-host >/dev/null 2>&1
    systemctl --user restart lotus-host || fail "systemctl --user could not start the host."
  else
    (
      set -a && . "$D/env" && set +a
      PATH="$lp" && export PATH && cd "$HOME" || exit 1
      if command -v setsid >/dev/null 2>&1; then
        setsid nohup "$D/lotus-host" >>"$D/host.log" 2>&1 </dev/null &
      else
        nohup "$D/lotus-host" >>"$D/host.log" 2>&1 </dev/null &
      fi
      echo $! >"$D/pid"
    )
  fi
}
remove_host() {
  stop_host
  if [ -f "$UNIT" ]; then
    user_systemd && systemctl --user disable lotus-host >/dev/null 2>&1
    rm -f "$UNIT"
    user_systemd && systemctl --user daemon-reload
  fi
  rm -rf "$D"
}

case "$STEP" in
status)
  echo "os=$(uname -s)"
  echo "arch=$ARCH"
  if [ -x "$D/lotus-host" ]; then
    echo kind=managed
    echo "version=$(cat "$D/version" 2>/dev/null)"
    running && echo running=1
  elif [ -e /usr/local/bin/lotus-host ] || [ -e /etc/systemd/system/lotus-host.service ]; then
    echo kind=manual
    secret=$(sed -n 's/^LOTUS_MOBILE_ADMIN_SECRET=//p' /etc/lotus-host.env 2>/dev/null)
    [ -n "$secret" ] && health "$secret" | sed -n 's/.*"build":"\([^"]*\)".*/version=\1/p'
  else
    echo kind=none
  fi
  ;;
download)
  [ -n "$ARCH" ] || fail "This machine is not Linux x64 or arm64."
  mkdir -p "$D" && chmod 700 "$D"
  url="https://github.com/alwisofwan1/lotus-releases/releases/download/v$ARG/lotus-host-linux-$ARCH"
  rm -f "$D/new" "$D/new.sha256"
  if ! { fetch "$url" "$D/new" && fetch "$url.sha256" "$D/new.sha256"; }; then
    rm -f "$D/new" "$D/new.sha256"
    echo NO_DOWNLOAD
    exit 3
  fi
  ;;
receive)
  case "$ARG" in new | new.sha256) ;; *) fail "unknown file $ARG" ;; esac
  mkdir -p "$D" && chmod 700 "$D"
  cat >"$D/$ARG.part" && mv -f "$D/$ARG.part" "$D/$ARG"
  ;;
check)
  want=$(cut -d' ' -f1 "$D/new.sha256" 2>/dev/null)
  have=$(sha256sum "$D/new" 2>/dev/null | cut -d' ' -f1)
  [ -n "$want" ] && [ "$want" = "$have" ] || { rm -f "$D/new" "$D/new.sha256"; fail "The download does not match its checksum."; }
  ;;
install)
  [ -f "$D/new" ] || fail "Nothing was downloaded."
  chmod 755 "$D/new"
  if [ -x "$D/lotus-host" ]; then
    mv -f "$D/lotus-host" "$D/previous"
    cp -f "$D/version" "$D/previous-version" 2>/dev/null
  fi
  mv -f "$D/new" "$D/lotus-host" && rm -f "$D/new.sha256"
  printf '%s\n' "$ARG" >"$D/version"
  if [ ! -f "$D/env" ]; then
    (umask 077 && printf 'LOTUS_MODE=standalone\nLOTUS_MOBILE_BIND=127.0.0.1:8787\nLOTUS_MOBILE_ADMIN_SECRET=%s\nLOTUS_HOST_LABEL=%s\n' \
      "$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')" "$(hostname)" >"$D/env")
  fi
  ;;
start)
  start_host
  ;;
health)
  secret=$(sed -n 's/^LOTUS_MOBILE_ADMIN_SECRET=//p' "$D/env" 2>/dev/null)
  body=""
  i=0
  while [ $i -lt 30 ]; do
    body=$(health "$secret" 2>/dev/null) && break
    i=$((i + 1))
    sleep 0.5
  done
  case "$body" in
    *"\"build\":\"$ARG\""*) ;;
    "") printf 'The host did not answer within 15 s.\n%s\n' "$(log_tail)" >&2; exit 1 ;;
    *) printf 'The host answered as another build: %s\n%s\n' "$body" "$(log_tail)" >&2; exit 1 ;;
  esac
  ;;
restore)
  if [ -x "$D/previous" ]; then
    mv -f "$D/previous" "$D/lotus-host"
    mv -f "$D/previous-version" "$D/version" 2>/dev/null
    start_host
  else
    # A first install has nothing to go back to: leave the machine as it was.
    remove_host
  fi
  ;;
remove)
  remove_host
  ;;
*)
  fail "unknown step $STEP"
  ;;
esac
exit 0

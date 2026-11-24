#!/usr/bin/env bash
#
# Standalone Host — mint a pairing code for Lotus Pocket, on the VPS itself.
#
# Until this existed, re-pairing a phone with a VPS host meant reading the admin secret
# out of the env file, finding the admin port in the advert, and hand-writing a `curl`
# — then typing the address and an 8-digit code into the phone within five minutes. A
# desktop shows a QR for the same job (`MobileTab.tsx`); a VPS had nothing (ADR-5 said a
# CLI would print one, and none did). This prints the same `lotus-pair://` invite the
# desktop does, as a QR in the terminal when `qrencode` is installed.
#
#   ssh my-vps 'bash ~/lotus/packages/host/deploy/pair.sh'
#   bash pair.sh --address https://pocket.example.com      # reached through a tunnel
#
set -euo pipefail

ENV_FILE="/etc/lotus-host.env"
STATE_DIR=""
ADDRESS=""
QR=1

usage() {
  cat <<'USAGE'
usage: pair.sh [options]

  --env-file PATH    environment file the host runs with (default: /etc/lotus-host.env)
  --state-dir PATH   where the host advertises its admin port
                     (default: LOTUS_STATE_DIR from the env file, else ~/.lotus)
  --address ADDR     what the PHONE dials: host:port, or an http(s) URL.
                     Default: LOTUS_PAIR_ADDRESS from the env file, else the address
                     the façade is bound to — which is only right when the phone can
                     reach that address directly (a tailnet IP, say).
  --no-qr            print the invite and the code, but no QR
  -h, --help         this
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file)  ENV_FILE="$2"; shift 2 ;;
    --state-dir) STATE_DIR="$2"; shift 2 ;;
    --address)   ADDRESS="$2"; shift 2 ;;
    --no-qr)     QR=0; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

die() { printf '  FAIL  %s\n' "$*" >&2; exit 1; }

# The env file and the advert are 0600 and owned by the user the unit runs as. Read them
# directly when that is us, through sudo when it is not — never by loosening either.
read_file() {
  if [[ -r "$1" ]]; then cat "$1"; else sudo cat "$1"; fi
}

env_value() {
  [[ -e "$ENV_FILE" ]] || return 0
  read_file "$ENV_FILE" | sed -n "s/^[[:space:]]*$1=//p" | tail -n1 | sed 's/[[:space:]]*$//'
}

# One JSON field, string or number. The host's replies are flat and its own, so this is
# the same `sed` install.sh reads the advert with rather than a jq dependency.
json_field() {
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\).*/\1/p" | head -n1
}

urlencode() {
  local s="$1" out="" c i
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      *) out+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

SECRET="$(env_value LOTUS_MOBILE_ADMIN_SECRET)"
[[ -n "$SECRET" ]] || die "no LOTUS_MOBILE_ADMIN_SECRET in $ENV_FILE. Without it the host \
starts with no admin surface, so nothing can mint a code. Run install.sh, which generates one."

if [[ -z "$STATE_DIR" ]]; then
  STATE_DIR="$(env_value LOTUS_STATE_DIR)"
  STATE_DIR="${STATE_DIR:-$HOME/.lotus}"
fi
ADVERT="$STATE_DIR/mobile-admin.json"
read_file "$ADVERT" >/dev/null 2>&1 || die "no admin advert at $ADVERT — the host is not \
running, or runs with another LOTUS_STATE_DIR. systemctl status lotus-host"
ADMIN_PORT="$(read_file "$ADVERT" | json_field port)"
[[ -n "$ADMIN_PORT" ]] || die "could not read a port from $ADVERT"
ADMIN="http://127.0.0.1:$ADMIN_PORT"

admin() {
  curl -fsS -m 10 -X "$1" -H "Authorization: Bearer $SECRET" "$ADMIN$2" 2>/dev/null
}

if [[ -z "$ADDRESS" ]]; then ADDRESS="$(env_value LOTUS_PAIR_ADDRESS)"; fi
if [[ -z "$ADDRESS" ]]; then
  HEALTH="$(admin GET /admin/health)" || die "/admin/health did not answer on $ADMIN. \
journalctl -u lotus-host -n 50"
  case "$HEALTH" in
    *'"mobile":null'*) die "the façade is not bound, so no phone can reach this host. \
Check LOTUS_MOBILE_BIND." ;;
  esac
  MOBILE="$(printf '%s' "$HEALTH" | sed -n 's/.*"mobile":{\([^}]*\)}.*/\1/p')"
  BOUND_HOST="$(printf '{%s}' "$MOBILE" | json_field host)"
  BOUND_PORT="$(printf '{%s}' "$MOBILE" | json_field port)"
  case "$BOUND_HOST" in
    127.*|::1|localhost|"")
      # Loopback is the right bind behind a tunnel (ADR-C), and the wrong thing to put in a
      # QR: the phone would dial its own 127.0.0.1. Only the operator knows the tunnel URL.
      die "the façade is bound to loopback ($BOUND_HOST:$BOUND_PORT), which a phone cannot \
dial. Pass the address the phone uses: --address https://… (or set LOTUS_PAIR_ADDRESS)." ;;
  esac
  ADDRESS="$BOUND_HOST:$BOUND_PORT"
fi

REPLY="$(admin POST /admin/pairing-code)" || die "POST /admin/pairing-code was refused. \
Is LOTUS_MOBILE_ADMIN_SECRET the one the running host was started with? \
(sudo systemctl restart lotus-host after editing $ENV_FILE)"
CODE="$(printf '%s' "$REPLY" | json_field code)"
EXPIRES_AT="$(printf '%s' "$REPLY" | json_field expiresAt)"
[[ -n "$CODE" ]] || die "the host answered without a code: $REPLY"

# Same envelope as the desktop's QR, pinned by contract/fixtures/pairing-invite.json.
INVITE="lotus-pair://invite?v=1&address=$(urlencode "$ADDRESS")&code=$CODE"

echo
if [[ "$QR" -eq 1 ]]; then
  if command -v qrencode >/dev/null 2>&1; then
    qrencode -t ANSIUTF8 -m 2 "$INVITE"
  else
    echo "  (install qrencode for a scannable QR here: sudo apt install qrencode)"
  fi
fi
cat <<OUT
  Scan the QR in Lotus Pocket, or type these on its pairing screen:

    address  $ADDRESS
    code     $CODE

  invite   $INVITE
OUT
if [[ -n "$EXPIRES_AT" ]]; then
  echo "  The code works once and lapses at $(date -d "@$(( EXPIRES_AT / 1000 ))" '+%H:%M:%S' 2>/dev/null || echo "+5 min")."
fi

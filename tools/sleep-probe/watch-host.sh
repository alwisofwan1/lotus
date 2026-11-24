#!/usr/bin/env bash
# Records what the host is doing across a macOS sleep/wake cycle — Part A of
# plans/lotus-pocket/issues/02-uji-tidur-macos-dan-tailnet.md.
#
# Samples every SAMPLE_SECS to a JSONL file so the answer is a timeline, not a
# memory. Each line carries a wall clock and a MONOTONIC seconds counter: the wall
# clock jumps across sleep (that jump is how long the machine was out), while the
# monotonic counter shows how many samples actually ran.
#
#   ./watch-host.sh                    # writes ./sleep-probe-<timestamp>.jsonl
#   SAMPLE_SECS=2 ./watch-host.sh      # tighter sampling
#
# Leave it running, put the MacBook to sleep naturally (not `pmset sleepnow` — the
# ticket asks for realistic), wake it, then Ctrl-C. Correlate afterwards with:
#
#   pmset -g log | grep -Ei 'Sleep +|Wake from|DarkWake' | tail -40
#
# It reads only. It never dispatches, never writes to a PTY, and never touches
# ~/.claude or ~/.lotus.

set -uo pipefail

SAMPLE_SECS="${SAMPLE_SECS:-5}"
API="${LOTUS_API:-http://127.0.0.1:9877}"

# Same resolution order as api_auth.rs: canonical first, legacy second. Dev builds
# use ~/.lotus-dev/ (ddfaefb4 moved dev state out of ~/.lotus).
key_file=""
for candidate in "$HOME/.lotus/api-server.key" "$HOME/.lotus-dev/api-server.key" "$HOME/.claude/api-server.key"; do
  [ -f "$candidate" ] && key_file="$candidate" && break
done

if [ -z "$key_file" ]; then
  echo "No api-server.key found — start Lotus once so it writes one." >&2
  echo "Looked in ~/.lotus/, ~/.lotus-dev/, ~/.claude/" >&2
  exit 1
fi

KEY="$(tr -d '\n' <"$key_file")"
OUT="${1:-sleep-probe-$(date +%Y%m%d-%H%M%S).jsonl}"

echo "watching  $API"
echo "key from  $key_file"
echo "writing   $OUT   (every ${SAMPLE_SECS}s — Ctrl-C to stop)"
echo

started_at="$(date +%s)"

while true; do
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mono=$(( $(date +%s) - started_at ))

  # `--max-time` matters more than it looks: a sleeping host does not refuse the
  # connection, it goes silent, so without a timeout the sampler blocks for
  # minutes and the timeline gets holes exactly where the interesting part is.
  health="$(curl -s --max-time 3 "$API/health" 2>/dev/null || echo '')"
  fleet="$(curl -s --max-time 3 -H "Authorization: Bearer $KEY" "$API/api/fleet?pageSize=50" 2>/dev/null || echo '')"

  reachable=false
  [ -n "$health" ] && reachable=true

  # Compact the fleet down to what the ticket asks about: which panes exist, are
  # they alive, and what turn are they in. jq is optional — without it the raw
  # body is kept, which is still evidence.
  if command -v jq >/dev/null 2>&1 && [ -n "$fleet" ]; then
    cells="$(printf '%s' "$fleet" | jq -c '[.items[]? | {paneId, status, isAlive, turn, turnAgeMs, sessionId}]' 2>/dev/null || echo 'null')"
    total="$(printf '%s' "$fleet" | jq -c '.total // null' 2>/dev/null || echo 'null')"
  else
    cells="$(printf '%s' "$fleet" | head -c 2000 | jq -Rs . 2>/dev/null || printf '""')"
    total='null'
  fi

  printf '{"at":"%s","monoSecs":%d,"reachable":%s,"total":%s,"cells":%s}\n' \
    "$now" "$mono" "$reachable" "$total" "$cells" >>"$OUT"

  # One line to stderr so the terminal shows liveness without needing a tail.
  if [ "$reachable" = true ]; then
    printf '\r%s  up    cells=%s   ' "$now" "$total" >&2
  else
    printf '\r%s  DOWN            ' "$now" >&2
  fi

  sleep "$SAMPLE_SECS"
done

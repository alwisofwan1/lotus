#!/usr/bin/env bash
#
# Runs Pocket on the emulator with hot reload attached — press `r` to reload, `R` to
# restart, `q` to quit.
#
#   bun run pocket:dev                 # the Home preview, with a fixed fleet
#   bun run pocket:dev lib/main.dart   # the real app
#
# The preview is the default because the real app has nothing to show yet: onboarding
# does not exist, so no host can be paired and Home draws its empty state. See
# `tool/preview_home.dart`.
#
# Booting is delegated to `emulator.sh` rather than repeated here, so there is one place
# that knows how to find the SDK, find a JDK, and tell a missing AVD from a dead boot.
# `flutter run` does the install-and-launch itself: doing it by hand with
# `adb install` + `adb shell monkey` races the package replacement and dies with
# `result code -5`.

set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${1:-tool/preview_home.dart}"

if [ ! -f "$TARGET" ]; then
  echo "error: no such target '$TARGET' (run from anywhere; paths are relative to apps/pocket)." >&2
  exit 1
fi

DEVICE="$(scripts/emulator.sh)"

echo "▸ running $TARGET on $DEVICE"
# `exec` so Ctrl-C and the r/R/q keys reach flutter directly rather than this wrapper.
exec flutter run -d "$DEVICE" -t "$TARGET"

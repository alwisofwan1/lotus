#!/usr/bin/env bash
#
# Ensures an Android emulator is running, and prints its device id on stdout.
#
#   bun run pocket:emulator          # boot it and leave it up
#   DEVICE=$(apps/pocket/scripts/emulator.sh)   # or compose with it, as dev.sh does
#
# Progress goes to stderr so stdout carries nothing but the device id — that is what
# makes it composable rather than something whose output has to be parsed.
#
# Three things on this path are easy to get wrong, each found the hard way:
#
#   1. `sdkmanager`/`avdmanager` need JAVA_HOME; `flutter` does not. A machine can have
#      `flutter doctor` reporting a healthy Android toolchain while `/usr/libexec/java_home`
#      fails outright, because Gradle resolves its own JDK. So one is resolved here rather
#      than assumed to be in the shell.
#   2. The SDK lives somewhere different per install (Homebrew cmdline-tools vs Android
#      Studio), so the path is discovered instead of hardcoded.
#   3. A missing AVD must fail loudly with the command to make one. Creating it downloads
#      ~3.8 GB, which is never something a dev script should start on its own.

set -euo pipefail

AVD="${POCKET_AVD:-lotus_pocket_pixel8}"

# ── Locate the Android SDK ────────────────────────────────────────────────────────
for candidate in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" \
  "$HOME/Library/Android/sdk" "/opt/homebrew/share/android-commandlinetools"; do
  if [ -n "$candidate" ] && [ -x "$candidate/platform-tools/adb" ]; then
    SDK="$candidate"
    break
  fi
done

if [ -z "${SDK:-}" ]; then
  echo "error: no Android SDK found (looked at ANDROID_HOME, ANDROID_SDK_ROOT," >&2
  echo "       ~/Library/Android/sdk, /opt/homebrew/share/android-commandlinetools)." >&2
  exit 1
fi

export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"
ADB="$SDK/platform-tools/adb"

# ── Locate a JDK, for the SDK tools that need one ────────────────────────────────
if [ -z "${JAVA_HOME:-}" ]; then
  for jdk in /opt/homebrew/opt/openjdk@21/libexec/*.jdk/Contents/Home \
    /opt/homebrew/opt/openjdk/libexec/*.jdk/Contents/Home \
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home"; do
    if [ -x "$jdk/bin/java" ]; then
      export JAVA_HOME="$jdk"
      break
    fi
  done
fi

# ── Already attached? Then there is nothing to do ────────────────────────────────
if "$ADB" devices | grep -qE "^emulator-[0-9]+[[:space:]]+device$"; then
  echo "▸ emulator already running" >&2
  "$ADB" devices | grep -oE "^emulator-[0-9]+" | head -1
  exit 0
fi

# ── The AVD has to exist ──────────────────────────────────────────────────────────
AVDMANAGER="$SDK/cmdline-tools/latest/bin/avdmanager"
if [ -x "$AVDMANAGER" ] && [ -n "${JAVA_HOME:-}" ]; then
  if ! "$AVDMANAGER" list avd 2>/dev/null | grep -q "Name: $AVD"; then
    {
      echo "error: no AVD named '$AVD'."
      echo
      echo "Create it (downloads a ~3.8 GB system image):"
      echo "  export JAVA_HOME=$JAVA_HOME"
      echo "  $SDK/cmdline-tools/latest/bin/sdkmanager --install \\"
      echo "      'emulator' 'system-images;android-35;google_apis;arm64-v8a'"
      echo "  $AVDMANAGER create avd \\"
      echo "      --name $AVD \\"
      echo "      --package 'system-images;android-35;google_apis;arm64-v8a' \\"
      echo "      --device pixel_8"
      echo
      echo "The 'Could not load devices.xml' warning it prints is harmless — check for"
      echo "'Name: $AVD' in 'avdmanager list avd' rather than trusting a silent run."
    } >&2
    exit 1
  fi
fi

# ── Boot it ───────────────────────────────────────────────────────────────────────
echo "▸ booting $AVD" >&2
# Detached and log-redirected on purpose: the emulator outlives this script, so the next
# run skips the cold boot entirely.
nohup "$SDK/emulator/emulator" -avd "$AVD" -no-snapshot-save -no-boot-anim \
  >/tmp/lotus-pocket-emulator.log 2>&1 &

printf '▸ waiting for boot' >&2
until "$ADB" shell getprop sys.boot_completed 2>/dev/null | grep -q 1; do
  # Matched on `-avd <name>` alone, never on the launcher's own name: `emulator` execs
  # into `qemu/<host>/qemu-system-aarch64 -avd <name> …`, so a pattern containing
  # "emulator -avd" stops matching the moment the launcher is replaced — a false
  # negative that aborts this script while the boot it is waiting for is going fine.
  if ! pgrep -f -- "-avd $AVD" >/dev/null 2>&1; then
    echo >&2
    echo "error: emulator exited before finishing boot. Last lines of the log:" >&2
    tail -20 /tmp/lotus-pocket-emulator.log >&2
    exit 1
  fi
  printf '.' >&2
  sleep 2
done
echo " up" >&2

"$ADB" devices | grep -oE "^emulator-[0-9]+" | head -1

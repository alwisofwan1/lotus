#!/usr/bin/env bash
#
# Builds the release APKs Lotus Pocket is distributed as (ADR-9: sideload, no store),
# then checks the artefacts rather than trusting the flags.
#
#   bun run pocket:release              # split per ABI — what you install on a phone
#   bun run pocket:release --install    # …then `adb install -r` it and prove the phone took it
#   bun run pocket:release --fat        # one universal APK, for handing to an unknown device
#   bun run pocket:release --aab        # an App Bundle, for a Play Store upload
#
# The version every artefact carries comes from `scripts/version.sh` — read it before
# changing how builds are numbered. The same four values are baked into Dart with
# `--dart-define`, which is how Diagnostics can show the commit and build time.
#
# Four things here are not defaults and are the reason this is a script rather than a
# remembered command line:
#
#   --obfuscate --split-debug-info   Dart symbols are stripped from the binary and kept
#                                    in build/symbols/. Without the second half, a
#                                    release stack trace is unreadable forever — and it
#                                    is the half everyone forgets, because the build
#                                    succeeds either way.
#   --split-per-abi                  A real phone is arm64. A universal APK carries
#                                    armeabi-v7a and x86_64 as well, roughly doubling it
#                                    for code that device can never run.
#   verification                     `apksigner` confirms the APK is signed with the
#                                    release key and not debuggable. A build that
#                                    silently fell back to the debug key looks identical
#                                    until an upgrade fails months later.
#   the build number                 never typed by hand — see version.sh.
#
# ADR-9 ships Pocket by sideload and that is still the default. `--aab` exists so the
# day a store build is wanted it is the same script, the same number and the same
# checks — not a second pipeline that drifts. The release key then serves as the Play
# upload key; Play App Signing re-signs what users download.

set -euo pipefail

cd "$(dirname "$0")/.."

FAT=0
AAB=0
INSTALL=0
BUILD_NUMBER=""
for arg in "$@"; do
  case "$arg" in
    --fat) FAT=1 ;;
    --aab) AAB=1 ;;
    --install) INSTALL=1 ;;
    --build-number=*) BUILD_NUMBER="${arg#*=}" ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [ "$AAB" -eq 1 ] && { [ "$FAT" -eq 1 ] || [ "$INSTALL" -eq 1 ]; }; then
  echo "--aab cannot be combined with --fat or --install: a bundle is not installable" >&2
  exit 1
fi

if [ ! -f android/key.properties ]; then
  cat >&2 <<'MSG'
Missing android/key.properties — the release build has no signing key.

It is gitignored on purpose, so a fresh clone needs it recreated. Point it at your
keystore:

  storePassword=…
  keyPassword=…
  keyAlias=lotus-pocket
  storeFile=/absolute/path/to/release.p12

If the keystore itself is gone, an upgrade of an already-installed Pocket is no longer
possible — Android matches package *and* signature. A new key means uninstalling first,
which takes the paired credential with it.
MSG
  exit 1
fi

STORE=$(grep '^storeFile=' android/key.properties | cut -d= -f2-)
if [ ! -f "$STORE" ]; then
  echo "key.properties points at a keystore that is not there: $STORE" >&2
  exit 1
fi

if [ ! -f android/app/google-services.json ]; then
  echo "Missing android/app/google-services.json — the build would fail at the" >&2
  echo "google-services plugin, and an app built without it cannot receive wake-ups." >&2
  exit 1
fi

# shellcheck source=scripts/version.sh
source scripts/version.sh  # cwd is apps/pocket by now; a relative $0 no longer resolves
[ -n "$BUILD_NUMBER" ] && POCKET_BUILD_NUMBER=$BUILD_NUMBER
echo "▸ Lotus Pocket $POCKET_VERSION ($POCKET_BUILD_NUMBER) · $POCKET_COMMIT"

# ─── The build number has to clear what is already on the phone ──────────────────────
# Android refuses a lower versionCode outright, and the only way past that is
# `adb uninstall`, which takes the paired credential with it (ADR-9). `version.sh` makes
# that impossible by construction; this checks it anyway, because a `--build-number=`
# override or a clock set wrong is how "by construction" fails.
#
# **`--split-per-abi` adds an offset to the build number**: Flutter's Gradle plugin
# computes `versionCode = base + 1000 × abiCode`, with armeabi-v7a 1, arm64-v8a 2,
# x86_64 4. A real phone takes the arm64 APK, so that is the code compared here.
ARM64_OFFSET=2000
OFFSET=$ARM64_OFFSET
[ "$FAT" -eq 1 ] && OFFSET=0 # a universal APK carries the base unmodified
WILL_INSTALL_AS=$((POCKET_BUILD_NUMBER + OFFSET))

# No device attached is not an error: the build still has to work for an APK being
# handed to someone else. It just cannot promise the install.
ADB=$(command -v adb || echo "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}}/platform-tools/adb")
INSTALLED=""
if [ "$AAB" -eq 0 ] && [ -x "$ADB" ]; then
  INSTALLED=$("$ADB" shell dumpsys package com.serayu.lotus_pocket 2>/dev/null |
    grep -o 'versionCode=[0-9]*' | head -1 | cut -d= -f2 || true)
  if [ -n "$INSTALLED" ]; then
    if [ "$WILL_INSTALL_AS" -le "$INSTALLED" ]; then
      echo "✗ the phone has versionCode $INSTALLED; this build would install as $WILL_INSTALL_AS" >&2
      echo "  and Android would refuse it. Drop --build-number=, or pass one above $((INSTALLED - OFFSET))." >&2
      exit 1
    fi
    echo "▸ phone has $INSTALLED — this installs as $WILL_INSTALL_AS"
  fi
fi

ARGS=(--release --obfuscate --split-debug-info=build/symbols
  --build-name="$POCKET_VERSION" --build-number="$POCKET_BUILD_NUMBER"
  --dart-define=POCKET_VERSION="$POCKET_VERSION"
  --dart-define=POCKET_BUILD_NUMBER="$POCKET_BUILD_NUMBER"
  --dart-define=POCKET_COMMIT="$POCKET_COMMIT"
  --dart-define=POCKET_BUILT_AT="$POCKET_BUILT_AT")

if [ "$AAB" -eq 1 ]; then
  # Play splits per ABI itself, from the bundle — and without the Gradle offset, so the
  # store's versionCode is the bare build number.
  ARGS+=(--dart-define=POCKET_CHANNEL=play)
  flutter build appbundle "${ARGS[@]}"
  OUT=build/app/outputs/bundle/release
  APKS=$(find "$OUT" -name '*.aab' | sort)
else
  ARGS+=(--dart-define=POCKET_CHANNEL=sideload)
  [ "$FAT" -eq 0 ] && ARGS+=(--split-per-abi)
  flutter build apk "${ARGS[@]}"
  OUT=build/app/outputs/flutter-apk
  APKS=$(find "$OUT" -name '*.apk' ! -name '*debug*' | sort)
fi

# ─── Verify, rather than assume ──────────────────────────────────────────────────────
# `apksigner` needs JAVA_HOME and `flutter` does not — the same trap `emulator.sh`
# already documents for `sdkmanager`, and one this script walked into on its first run:
# the APKs built fine and verification died with "Unable to locate a Java Runtime".
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

BUILD_TOOLS=$(ls -d "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}}"/build-tools/* 2>/dev/null | sort -V | tail -1 || true)
APKSIGNER="${BUILD_TOOLS:+$BUILD_TOOLS/apksigner}"

echo
echo "▸ Artefacts"
for apk in $APKS; do
  SIZE=$(du -h "$apk" | cut -f1)
  printf '  %-46s %s\n' "$(basename "$apk")" "$SIZE"

  # An .aab is signed with jarsigner, which apksigner does not read.
  if [ "$AAB" -eq 0 ] && [ -n "$APKSIGNER" ] && [ -x "$APKSIGNER" ]; then
    if ! "$APKSIGNER" verify --print-certs "$apk" > /tmp/lotus-apksig.$$ 2>&1; then
      echo "    ✗ signature did not verify" >&2
      cat /tmp/lotus-apksig.$$ >&2; rm -f /tmp/lotus-apksig.$$
      exit 1
    fi
    # The debug key is `CN=Android Debug`. Catching it here is the whole point: a
    # release accidentally signed with it installs and runs perfectly today.
    if grep -q "CN=Android Debug" /tmp/lotus-apksig.$$; then
      echo "    ✗ signed with the DEBUG key — check android/key.properties" >&2
      rm -f /tmp/lotus-apksig.$$; exit 1
    fi
    # `certificate DN:`, not `Subject:` — the first run of this script printed an empty
    # signer line because the pattern was guessed rather than read off the tool.
    printf '    signer: %s\n' \
      "$(grep -m1 'certificate DN:' /tmp/lotus-apksig.$$ | sed 's/.*certificate DN: //')"
    printf '    sha256: %s\n' \
      "$(grep -m1 'certificate SHA-256 digest:' /tmp/lotus-apksig.$$ | sed 's/.*digest: //')"
    rm -f /tmp/lotus-apksig.$$
  fi
done

[ -n "$APKSIGNER" ] || echo "  (apksigner not found — signature unverified)" >&2

echo
echo "▸ Symbols kept in build/symbols — a release crash is only readable with these."
echo "  Archive them beside the APK you ship, or the trace is noise."
echo
[ "$AAB" -eq 1 ] && {
  echo "▸ Upload $OUT/app-release.aab to Play Console — versionCode $POCKET_BUILD_NUMBER."
  exit 0
}

APK="$PWD/$OUT/app-arm64-v8a-release.apk"
[ "$FAT" -eq 1 ] && APK="$PWD/$OUT/app-release.apk"

if [ "$INSTALL" -eq 0 ]; then
  echo "▸ Install on a connected phone (or re-run with --install):"
  echo "    adb install -r $APK"
  exit 0
fi

# ─── Install, then read back what the phone says it has ──────────────────────────────
# `adb install -r` keeps app data, so the pairing survives. Never `flutter install` —
# it uninstalls first. And "Success" is adb's word, not the phone's: the versionCode
# read back afterwards is the proof the new build is the one that is running.
echo "▸ Installing on $("$ADB" get-serialno 2>/dev/null || echo 'the attached phone')"
"$ADB" install -r "$APK"
NOW=$("$ADB" shell dumpsys package com.serayu.lotus_pocket 2>/dev/null |
  grep -o 'versionCode=[0-9]*' | head -1 | cut -d= -f2 || true)
if [ "$NOW" != "$WILL_INSTALL_AS" ]; then
  echo "✗ phone reports versionCode ${NOW:-nothing}, expected $WILL_INSTALL_AS" >&2
  exit 1
fi
echo "✓ phone now runs $POCKET_VERSION ($POCKET_BUILD_NUMBER) · $POCKET_COMMIT — Diagnostics shows the same"

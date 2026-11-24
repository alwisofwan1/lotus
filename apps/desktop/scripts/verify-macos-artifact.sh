#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Lotus"
APP_PATH="$PROJECT_DIR/src-tauri/target/release/bundle/macos/$APP_NAME.app"
INSTALLED_APP_PATH="/Applications/$APP_NAME.app"
DMG_DIR="$PROJECT_DIR/src-tauri/target/release/bundle/dmg"

find_built_dmg() {
  find "$DMG_DIR" -maxdepth 1 -type f -name "${APP_NAME}_*.dmg" | head -n 1
}

print_header() {
  printf '\n==> %s\n' "$1"
}

run_check() {
  local label="$1"
  shift

  echo "-- $label"
  if "$@"; then
    echo "OK: $label"
    return 0
  else
    local status=$?
    echo "WARN: $label failed with exit code $status"
    return 0
  fi
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This verifier must be run on macOS." >&2
  exit 1
fi

if [ ! -d "$APP_PATH" ]; then
  echo "Expected app bundle not found: $APP_PATH" >&2
  echo "Build Lotus first with: bun run tauri:build:mac" >&2
  exit 1
fi

DMG_PATH="$(find_built_dmg)"
if [ -z "$DMG_PATH" ]; then
  echo "Expected dmg artifact not found in $DMG_DIR" >&2
  echo "Build Lotus first with: bun run tauri:build:mac" >&2
  exit 1
fi

ARCH="$(uname -m)"

print_header "Artifact paths"
echo "App : $APP_PATH"
if [ -d "$INSTALLED_APP_PATH" ]; then
  echo "Installed app : $INSTALLED_APP_PATH"
fi
echo "DMG : $DMG_PATH"
echo "Host arch : $ARCH"

print_header "Bundle metadata"
/usr/libexec/PlistBuddy -c "Print :CFBundleName" "$APP_PATH/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP_PATH/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP_PATH/Contents/Info.plist" || true
/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$APP_PATH/Contents/Info.plist" || true

print_header "Mach-O architecture"
run_check "Inspect binary architecture" file "$APP_PATH/Contents/MacOS/lotus"
# The session daemon (ADR-0067): missing = every terminal falls back to in-process and dies on quit;
# an invalid signature = SIGKILL on exec with no output.
[ -x "$APP_PATH/Contents/MacOS/lotus-sessiond" ] || { echo "ERROR: lotus-sessiond is not in the bundle"; exit 1; }
run_check "Session daemon architecture" file "$APP_PATH/Contents/MacOS/lotus-sessiond"
run_check "Session daemon signature" codesign --verify --strict --verbose=2 "$APP_PATH/Contents/MacOS/lotus-sessiond"

print_header "Google OAuth client"
# Baked in by option_env! (scripts/check-release-env.mjs). 0 hits = Connectors → Google is
# "Not available in this build" for every user.
GOOGLE_HITS="$(grep -c -a 'apps.googleusercontent.com' "$APP_PATH/Contents/MacOS/lotus" || true)"
if [ "${GOOGLE_HITS:-0}" -gt 0 ]; then
  echo "OK: Google client is baked into the binary"
else
  echo "WARN: no Google client in the binary — Connectors → Google is unavailable for every user"
fi

print_header "Code signing"
run_check "codesign details" codesign -dv --verbose=4 "$APP_PATH"
run_check "codesign verification" codesign --verify --deep --strict --verbose=2 "$APP_PATH"

print_header "Gatekeeper"
run_check "spctl assessment for app" spctl --assess --type execute --verbose=4 "$APP_PATH"
run_check "spctl assessment for dmg" spctl --assess --type open --verbose=4 "$DMG_PATH"

if [ -d "$INSTALLED_APP_PATH" ]; then
  print_header "Installed app"
  run_check "codesign verification for installed app" codesign --verify --deep --strict --verbose=2 "$INSTALLED_APP_PATH"
  run_check "spctl assessment for installed app" spctl --assess --type execute --verbose=4 "$INSTALLED_APP_PATH"
fi

print_header "Quarantine attribute"
run_check "xattr quarantine check" xattr -p com.apple.quarantine "$APP_PATH"

print_header "Summary"
cat <<EOF
- If codesign or spctl reports warnings, the app is still usable for internal sharing, but recipients may need Right click > Open or Privacy & Security > Open Anyway.
- If the binary architecture does not match the recipient Mac (for example arm64 build on Intel Mac), the app may not launch.
- This repository currently builds macOS artifacts, but does not configure Apple Developer signing or notarization.
EOF

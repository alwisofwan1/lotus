#!/bin/bash
set -e

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Lotus"
APP_PATH="$PROJECT_DIR/src-tauri/target/release/bundle/macos/$APP_NAME.app"
BUNDLE_DIR="$PROJECT_DIR/src-tauri/target/release/bundle/dmg"

find_built_dmg() {
  find "$BUNDLE_DIR" -maxdepth 1 -type f -name "${APP_NAME}_*.dmg" | head -n 1
}

echo "==> Cleaning cache..."
rm -rf "$PROJECT_DIR/out" "$PROJECT_DIR/.next/cache"

echo "==> Building app..."
cd "$PROJECT_DIR"
bun run tauri:build

if [ ! -d "$APP_PATH" ]; then
  echo "Expected app bundle not found: $APP_PATH" >&2
  exit 1
fi

DMG_SOURCE="$(find_built_dmg)"
if [ -z "$DMG_SOURCE" ]; then
  echo "Expected dmg artifact not found in $BUNDLE_DIR" >&2
  exit 1
fi

DMG_PATH="$PROJECT_DIR/$(basename "$DMG_SOURCE")"

echo "==> Copying generated DMG..."
cp -f "$DMG_SOURCE" "$DMG_PATH"

echo ""
echo "Done!"
echo "  App   → $APP_PATH"
echo "  DMG   → $DMG_PATH"

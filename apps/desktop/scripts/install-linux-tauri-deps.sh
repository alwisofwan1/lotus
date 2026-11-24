#!/usr/bin/env bash
# Installs system packages required to build this Tauri 2 app on Debian/Ubuntu/WSL.
# See: https://v2.tauri.app/start/prerequisites/
#
# Native Windows does not use pkg-config/gio-sys; install MSVC Build Tools + WebView2 instead.

set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "This script is only for Linux or WSL."
    echo "On native Windows, install: Visual Studio C++ Build Tools (Desktop development with C++),"
    echo "Windows 10/11 SDK, WebView2 — https://v2.tauri.app/start/prerequisites/"
    echo "Then build with: bun run tauri:build:win"
    exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
    echo "This script targets apt-based distros (Debian/Ubuntu). For Arch/Fedora/etc., see:"
    echo "https://v2.tauri.app/start/prerequisites/"
    exit 1
fi

echo "Installing Tauri Linux build dependencies (requires sudo)..."
sudo apt-get update
sudo apt-get install -y \
    pkg-config \
    libwebkit2gtk-4.1-dev \
    build-essential \
    curl \
    wget \
    file \
    libxdo-dev \
    libssl-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev

echo "Done. Run: bun run tauri:build"

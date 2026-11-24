#!/usr/bin/env bash
# Builds `lotus-sessiond` for Linux as a static musl binary, for the Standalone Host to embed
# (ADR-0067, plans/session-daemon/PHASE-5.md). Writes packages/host/dist/lotus-sessiond-linux-<arch>,
# the same desktop → host direction as build-host-bundle.mjs.
#
#   apps/desktop/scripts/build-sessiond-linux.sh            # x64 (devbox-vps)
#   apps/desktop/scripts/build-sessiond-linux.sh x64 arm64
#
# Docker, not a local cross toolchain: this Mac has no musl linker, and `rust:1-alpine` is musl
# natively. Each arch gets its own target volume — never the repo's target/ (CLAUDE.md: a foreign
# build in it overwrote a crate's rlib and broke tauri:dev).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
src_tauri="$here/../src-tauri"
out="$here/../../../packages/host/dist"
mkdir -p "$out"

archs=("$@")
[ ${#archs[@]} -eq 0 ] && archs=(x64)

for arch in "${archs[@]}"; do
  case "$arch" in
    x64) platform=linux/amd64 ;;
    arm64) platform=linux/arm64 ;;
    *) echo "unknown arch '$arch' (x64 or arm64)" >&2; exit 2 ;;
  esac
  name="lotus-sessiond-linux-$arch"
  echo "==> $name ($platform)"
  docker run --rm --platform "$platform" \
    -v "$src_tauri":/src:ro \
    -v "lotus-sessiond-target-$arch":/target \
    -v "lotus-cargo-registry-$arch":/usr/local/cargo/registry \
    -v "$out":/out \
    -w /src \
    -e CARGO_TARGET_DIR=/target \
    -e CARGO_PROFILE_RELEASE_STRIP=symbols \
    rust:1-alpine sh -euc "
      apk add --no-cache musl-dev >/dev/null
      cargo build --release --locked -p lotus-sessiond --bin lotus-sessiond
      cp /target/release/lotus-sessiond /out/$name.tmp
      mv /out/$name.tmp /out/$name
    "
  # A dynamically linked result would start on the build image and nowhere else.
  if ! file "$out/$name" | grep -q 'static'; then
    echo "$name is not statically linked: $(file "$out/$name")" >&2
    exit 1
  fi
  ls -l "$out/$name"
done

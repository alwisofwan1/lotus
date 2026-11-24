#!/usr/bin/env bash
#
# The one place a Pocket build gets its identity. Sourced, not run:
#
#   source scripts/version.sh            # sets the four POCKET_* variables below
#   scripts/version.sh                   # or run it to print them
#
# Every packaging path — the sideload APK, a Play Store bundle, an App Store archive —
# must take these from here, so the number on the phone, in the store console and in
# Diagnostics are always the same number.
#
#   POCKET_VERSION       semver, the name half of `version:` in pubspec.yaml
#   POCKET_BUILD_NUMBER  minutes since the Unix epoch, UTC
#   POCKET_COMMIT        short git sha, `-dirty` when the tree had uncommitted changes
#   POCKET_BUILT_AT      ISO-8601 UTC timestamp of this build
#
# ─── Why the build number is a timestamp ─────────────────────────────────────────────
# Android refuses to install a lower versionCode over a higher one, Play refuses to
# accept one, and App Store Connect refuses a CFBundleVersion it has seen. So the number
# must rise on *every* build, from *every* branch, on *every* machine:
#
#   - a hand-edited `+21` in pubspec drifted to 2026 on a real phone and 21 in git;
#   - asking the attached device (what release.sh did before) only works with a device
#     attached, and inflated by the ABI offset when it was fed back in;
#   - `git rev-list --count HEAD` goes backwards when you build a shorter branch.
#
# Minutes since the epoch has none of those failures. It is ~29.7 million in 2026,
# far above any number a phone here already carries (6064 on 2026-10-03), and it
# stays under Play's 2,100,000,000 ceiling — including the 4000 that `--split-per-abi`
# adds for x86_64 — for the next ~3900 years. Two builds in the same minute get the same
# number; that is the one case `--build-number=` exists to override.

_pocket_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

POCKET_VERSION=$(grep '^version:' "$_pocket_root/pubspec.yaml" | awk '{print $2}' | cut -d+ -f1)
POCKET_BUILD_NUMBER=$(($(date -u +%s) / 60))
POCKET_COMMIT=$(git -C "$_pocket_root" rev-parse --short=8 HEAD 2>/dev/null || echo unknown)
if [ "$POCKET_COMMIT" != unknown ] && ! git -C "$_pocket_root" diff --quiet HEAD -- . 2>/dev/null; then
  POCKET_COMMIT="$POCKET_COMMIT-dirty"
fi
POCKET_BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

unset _pocket_root

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "POCKET_VERSION=$POCKET_VERSION"
  echo "POCKET_BUILD_NUMBER=$POCKET_BUILD_NUMBER"
  echo "POCKET_COMMIT=$POCKET_COMMIT"
  echo "POCKET_BUILT_AT=$POCKET_BUILT_AT"
fi

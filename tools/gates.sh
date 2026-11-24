#!/usr/bin/env bash
# Deterministic gates for agent-made changes. Checks only what the branch touched, because
# main itself is not clean (tsc and eslint have pre-existing errors): a gate fails when the
# change adds a problem, not when it inherits one.
#
#   tools/gates.sh                 # compare against origin/main
#   GATES_BASE=main tools/gates.sh # another base (a Factory Run sets it to its own origin/<base>)
#
# Exit 0 = all gates passed, 1 = a gate failed (also: a changed area whose tool is not installed),
# 2 = setup error.
set -uo pipefail

# macOS's /bin/bash is 3.2: no `mapfile`, so CHANGED stays empty and every gate is skipped —
# green with nothing checked (seen 2026-10-08). Refuse instead.
if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "gates: needs bash 4 or newer, this is $BASH_VERSION (brew install bash)" >&2
  exit 2
fi

ROOT=$(git rev-parse --show-toplevel) || exit 2
cd "$ROOT"
command -v mise >/dev/null && eval "$(mise env -s bash)"

BASE=${GATES_BASE:-origin/main}
MB=$(git merge-base "$BASE" HEAD) || { echo "gates: no merge base with $BASE" >&2; exit 2; }

# Committed + uncommitted + untracked, existing files only.
mapfile -t CHANGED < <(
  { git diff --name-only "$MB"; git ls-files --others --exclude-standard; } |
    sort -u | while read -r f; do [ -f "$f" ] && echo "$f"; done
)

failed=()
skipped=()
passed=()
step() { echo; echo "── $1"; }

only() { printf '%s\n' "${CHANGED[@]}" | grep -E "$1" || true; }

DESKTOP_TS=$(only '^apps/desktop/.*\.(ts|tsx|mts|mjs)$' | grep -v '^apps/desktop/src-tauri/' || true)
RUST=$(only '^apps/desktop/src-tauri/.*\.(rs|toml)$|^packages/[^/]+/.*\.rs$')
HOST=$(only '^packages/host/')
WEB=$(only '^apps/web/')
POCKET=$(only '^apps/pocket/.*\.dart$|^apps/pocket/pubspec')

echo "gates: base $BASE ($(git rev-parse --short "$MB")), ${#CHANGED[@]} changed file(s)"

# A missing tool is a setup error, never a pass: a step whose tool cannot start has checked nothing.
need() {
  command -v "$1" >/dev/null || { echo "gates: '$1' is not on PATH (is the repo's mise.toml trusted?)" >&2; exit 2; }
}

if [ -n "$DESKTOP_TS" ]; then
  need bun
  need bunx
  rel=$(sed 's#^apps/desktop/##' <<<"$DESKTOP_TS")
  # A worktree borrows the main checkout's packages when both lockfiles match: one install is about
  # 450 MB, once per Factory Run. The link lives only while the gate runs, so the agent never writes
  # into the main checkout's packages.
  main=$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)
  if [ ! -e apps/desktop/node_modules ] && [ "$main" != "$(pwd -P)" ] &&
    [ -d "$main/apps/desktop/node_modules/.bin" ] && cmp -s apps/desktop/bun.lock "$main/apps/desktop/bun.lock"; then
    ln -s "$main/apps/desktop/node_modules" apps/desktop/node_modules
    trap 'rm -f "$ROOT/apps/desktop/node_modules"' EXIT
    echo "gates: using the packages of $main"
  fi
  [ -d apps/desktop/node_modules/.bin ] || (cd apps/desktop && bun install --frozen-lockfile >/dev/null) ||
    { echo "gates: bun install failed in apps/desktop" >&2; exit 2; }

  step "eslint (changed desktop files)"
  if (cd apps/desktop && xargs bunx eslint --no-warn-ignored <<<"$rel"); then passed+=(eslint); else failed+=(eslint); fi

  step "tsc (errors in changed desktop files)"
  tsc_out=$(cd apps/desktop && bunx tsc --noEmit -p . 2>&1)
  tsc_status=$?
  own=$(grep -F -f <(echo "$rel") <<<"$tsc_out" | grep 'error TS' || true)
  if [ -n "$own" ]; then echo "$own"; failed+=(tsc)
  # Non-zero with no "error TS" line at all: tsc itself did not run.
  elif [ $tsc_status -ne 0 ] && ! grep -q 'error TS' <<<"$tsc_out"; then echo "$tsc_out" | tail -20; failed+=(tsc)
  else passed+=(tsc); fi

  # A test file that already fails at the merge base is inherited, not caused by the change
  # (main has some). Only files that fail here AND pass (or do not exist) at the base fail the gate.
  step "vitest (tests related to the change)"
  # Real path: vitest reports /private/var/…, mktemp says /var/…, and the names must match.
  tmp=$(cd "$(mktemp -d)" && pwd -P)
  (cd apps/desktop && bunx vitest run --changed "$MB" --passWithNoTests --reporter=default --reporter=json --outputFile="$tmp/head.json")
  failing() { # <json> → failed test files, relative to apps/desktop
    [ -s "$1" ] || { echo "__no_report__"; return; }
    bun -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      for (const t of r.testResults ?? []) if (t.status !== "passed") console.log(require("path").relative(process.argv[2], t.name));' \
      "$1" "$2"
  }
  head_failed=$(failing "$tmp/head.json" "$ROOT/apps/desktop")
  # Once more, alone: a file that timed out under a busy machine is not the change's fault.
  if [ -n "$head_failed" ] && [ "$head_failed" != "__no_report__" ]; then
    (cd apps/desktop && xargs bunx vitest run --reporter=json --outputFile="$tmp/again.json" <<<"$head_failed" >/dev/null 2>&1)
    head_failed=$(failing "$tmp/again.json" "$ROOT/apps/desktop")
  fi
  if [ -z "$head_failed" ]; then passed+=(vitest)
  elif [ "$head_failed" = "__no_report__" ]; then echo "gates: vitest wrote no report"; failed+=(vitest)
  else
    base_tree="$tmp/base"
    git worktree add --detach --quiet "$base_tree" "$MB"
    ln -s "$ROOT/apps/desktop/node_modules" "$base_tree/apps/desktop/node_modules"
    existing=$(while read -r f; do [ -f "$base_tree/apps/desktop/$f" ] && echo "$f"; done <<<"$head_failed")
    base_failed=""
    if [ -n "$existing" ]; then
      (cd "$base_tree/apps/desktop" && xargs bunx vitest run --reporter=json --outputFile="$tmp/base.json" <<<"$existing" >/dev/null 2>&1)
      base_failed=$(failing "$tmp/base.json" "$base_tree/apps/desktop")
    fi
    git worktree remove --force "$base_tree"
    new_failed=$(grep -vxF -f <(printf '%s\n' "$base_failed") <<<"$head_failed" || true)
    inherited=$(grep -xF -f <(printf '%s\n' "$base_failed") <<<"$head_failed" || true)
    [ -n "$inherited" ] && { echo "already failing at $BASE (ignored):"; sed 's/^/  /' <<<"$inherited"; }
    if [ -z "$new_failed" ]; then passed+=(vitest)
    else echo "failing because of this change:"; sed 's/^/  /' <<<"$new_failed"; failed+=(vitest); fi
  fi
  rm -rf "$tmp"
fi

# Like vitest: a test that already fails at the merge base is inherited (main has two pty tests
# that fail on some machines), so only tests failing here AND passing (or missing) at the base fail
# the gate. The base is built in its own target dir — never this tree's (CLAUDE.md, 2026-09-28) —
# and what it says is cached per merge base, because every Rust change on the same base asks again.
if [ -n "$RUST" ]; then
  step "cargo test"
  if ! command -v cargo >/dev/null; then
    # A Rust change nothing checked is not green.
    echo "gates: Rust files changed but cargo is not installed here, so nothing checked them"; failed+=("cargo (not installed)")
  else
    manifest=apps/desktop/src-tauri/Cargo.toml
    ctmp=$(mktemp -d) || { echo "gates: cannot make a temp dir" >&2; exit 2; }
    cargo_failed() { sed -n 's/^test \(.*\) \.\.\. FAILED$/\1/p' "$1" | sort -u; }
    cargo test --no-fail-fast --manifest-path "$manifest" 2>&1 | tee "$ctmp/head.log"
    cargo_status=${PIPESTATUS[0]}
    head_failed=$(cargo_failed "$ctmp/head.log")
    # Once more, alone: a test that timed out under a busy machine is not the change's fault.
    again_clean=false
    if [ "$cargo_status" -ne 0 ] && [ -n "$head_failed" ]; then
      xargs cargo test --no-fail-fast --manifest-path "$manifest" -- --exact <<<"$head_failed" >"$ctmp/again.log" 2>&1 &&
        grep -q '^test result:' "$ctmp/again.log" && again_clean=true
      head_failed=$(cargo_failed "$ctmp/again.log")
    fi
    if [ "$cargo_status" -eq 0 ] || $again_clean; then passed+=(cargo)
    # Non-zero with no failed test: it did not build, or a test binary crashed.
    elif [ -z "$head_failed" ]; then tail -30 "$ctmp/head.log"; echo "gates: cargo test failed with no failing test (a build error?)"; failed+=(cargo)
    else
      cache_dir="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)/lotus-gates"
      cache="$cache_dir/cargo-$MB.txt" # lines: "PASS <test>" / "FAIL <test>"
      mkdir -p "$cache_dir" && touch "$cache"
      unknown=$(while read -r t; do grep -qxF -e "PASS $t" -e "FAIL $t" "$cache" || echo "$t"; done <<<"$head_failed")
      if [ -n "$unknown" ]; then
        echo "gates: building $(git rev-parse --short "$MB") to see which of these already fail there (once per base)"
        base_tree="$ctmp/base"
        git worktree add --detach --quiet "$base_tree" "$MB"
        (cd "$base_tree" && CARGO_TARGET_DIR="$ctmp/base-target" xargs cargo test --no-fail-fast --manifest-path "$manifest" -- --exact <<<"$unknown" >"$ctmp/base.log" 2>&1)
        git worktree remove --force "$base_tree"
        # A base that did not build says nothing: nothing is cached and every failure counts as new.
        if grep -q '^test result:' "$ctmp/base.log"; then
          base_now=$(cargo_failed "$ctmp/base.log")
          while read -r t; do
            if grep -qxF -e "$t" <<<"$base_now"; then echo "FAIL $t"; else echo "PASS $t"; fi
          done <<<"$unknown" >>"$cache"
        else
          echo "gates: the base did not build, so no failure can be called inherited"
        fi
      fi
      base_failed=$(sed -n 's/^FAIL //p' "$cache")
      new_failed=$(grep -vxF -f <(printf '%s\n' "$base_failed") <<<"$head_failed" || true)
      inherited=$(grep -xF -f <(printf '%s\n' "$base_failed") <<<"$head_failed" || true)
      [ -n "$inherited" ] && { echo "already failing at $BASE (ignored):"; sed 's/^/  /' <<<"$inherited"; }
      if [ -z "$new_failed" ]; then passed+=(cargo)
      else echo "failing because of this change:"; sed 's/^/  /' <<<"$new_failed"; failed+=(cargo); fi
    fi
    rm -rf "$ctmp"
  fi
fi

if [ -n "$HOST" ]; then
  step "packages/host tests"
  [ -d packages/host/node_modules ] || (cd packages/host && bun install --frozen-lockfile >/dev/null)
  if (cd packages/host && bun run test); then passed+=(host); else failed+=(host); fi
fi

if [ -n "$WEB" ]; then
  step "apps/web check + tests"
  [ -d apps/web/node_modules ] || (cd apps/web && bun install --frozen-lockfile >/dev/null)
  if (cd apps/web && bun run check && bun run test); then passed+=(web); else failed+=(web); fi
fi

if [ -n "$POCKET" ]; then
  step "pocket analyze + tests"
  if ! command -v flutter >/dev/null; then
    echo "gates: Dart files changed but flutter is not installed here, so nothing checked them"; failed+=("pocket (flutter not installed)")
  elif (cd apps/pocket && flutter analyze && flutter test); then passed+=(pocket); else failed+=(pocket); fi
fi

echo
echo "gates: passed [${passed[*]:-}] skipped [${skipped[*]:-}] failed [${failed[*]:-}]"
[ ${#failed[@]} -eq 0 ]

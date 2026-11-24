#!/usr/bin/env bash
# Refuses client names, ticket keys and other private identifiers in this public repo.
#
# The term list is NOT in the repo: publishing it would publish the very names it guards.
# It comes from $PRIVATE_TERMS (newline-separated, CI secret) or from the file
# $LOTUS_PRIVATE_TERMS_FILE (default ~/.config/lotus/private-terms). Terms are
# case-insensitive extended regexes, one per line.
#
# Usage:
#   tools/check-private-terms.sh               # staged files (pre-commit hook)
#   tools/check-private-terms.sh --tree        # every tracked file (CI)
#   tools/check-private-terms.sh --msg FILE    # a commit message (commit-msg hook)
#   tools/check-private-terms.sh --log RANGE   # commit messages in a git range (CI)
#
# Output names files and line numbers only, never the matching text, so a CI log does not
# leak the term it caught.
set -euo pipefail

terms=$(mktemp)
trap 'rm -f "$terms"' EXIT
if [[ -n "${PRIVATE_TERMS:-}" ]]; then
  # A blank line would be an empty pattern, which matches every line: drop them (and CRs).
  printf '%s\n' "$PRIVATE_TERMS" | tr -d '\r' | grep -v '^[[:space:]]*$' >"$terms" || true
else
  file="${LOTUS_PRIVATE_TERMS_FILE:-$HOME/.config/lotus/private-terms}"
  if [[ ! -r "$file" ]]; then
    echo "check-private-terms: no term list ($file missing, PRIVATE_TERMS unset) — skipped" >&2
    exit 0
  fi
  grep -v '^[[:space:]]*$' "$file" >"$terms" || true
fi
[[ -s "$terms" ]] || { echo "check-private-terms: term list is empty — skipped" >&2; exit 0; }

hits=""
case "${1:-}" in
  --tree)
    hits=$(git grep -nIiE -f "$terms" -- . ':!tools/check-private-terms.sh' | cut -d: -f1,2 || true) ;;
  --msg)
    hits=$(grep -nIiE -f "$terms" "$2" | cut -d: -f1 | sed 's/^/commit message line /' || true) ;;
  --log)
    for c in $(git rev-list "$2"); do
      git log -1 --format=%B "$c" | grep -qiE -f "$terms" && hits+="commit $c message"$'\n'
    done ;;
  "")
    hits=$(git grep --cached -nIiE -f "$terms" -- . ':!tools/check-private-terms.sh' | cut -d: -f1,2 || true) ;;
  *) echo "usage: $0 [--tree | --msg FILE | --log RANGE]" >&2; exit 2 ;;
esac

if [[ -n "$hits" ]]; then
  echo "Private identifier found (client name, ticket key, Slack ID, ...). This repo is public." >&2
  echo "Replace it with a placeholder (Acme, Orbit, TKT-123, U0EXAMPLE01):" >&2
  printf '%s\n' "$hits" | sed '/^$/d; s/^/  /' >&2
  exit 1
fi

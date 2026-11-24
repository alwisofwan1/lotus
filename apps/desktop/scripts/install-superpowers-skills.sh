#!/usr/bin/env bash
# Install obra/superpowers skills for use in the Lotus Bridge Agent.
# Skills are cloned to ~/.agents/superpowers and symlinked into ~/.agents/skills/
# so they are auto-discovered by the Bridge composer's filesystem-skills-loader.
#
# Usage: bash scripts/install-superpowers-skills.sh
# Re-run any time to update to the latest version.

set -euo pipefail

SUPERPOWERS_REPO="https://github.com/obra/superpowers"
SUPERPOWERS_DIR="${HOME}/.agents/superpowers"
SKILLS_DIR="${HOME}/.agents/skills"

# ── Clone or update ──────────────────────────────────────────────────────────

if [ -d "${SUPERPOWERS_DIR}/.git" ]; then
  echo "→ Updating existing clone at ${SUPERPOWERS_DIR}..."
  git -C "${SUPERPOWERS_DIR}" pull --ff-only --quiet
else
  echo "→ Cloning superpowers into ${SUPERPOWERS_DIR}..."
  git clone --depth=1 "${SUPERPOWERS_REPO}" "${SUPERPOWERS_DIR}"
fi

# ── Symlink skills ────────────────────────────────────────────────────────────

mkdir -p "${SKILLS_DIR}"

linked=0
for skill_dir in "${SUPERPOWERS_DIR}/skills"/*/; do
  [ -d "${skill_dir}" ] || continue
  name=$(basename "${skill_dir}")
  target="${SKILLS_DIR}/superpowers-${name}"
  # Remove stale link before re-linking (handles repo moves)
  [ -L "${target}" ] && rm "${target}"
  ln -s "${skill_dir}" "${target}"
  linked=$((linked + 1))
done

echo "✅ Linked ${linked} superpowers skills into ${SKILLS_DIR}"
echo ""
echo "Skills are now available in the Bridge composer:"
echo "  • Type @ to browse all available skills"
echo "  • Type /skills list to enumerate them"
echo "  • Example: @superpowers-dispatching-parallel-agents"

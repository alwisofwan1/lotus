---
name: github
description: Interact with GitHub — repos, pull requests, issues, releases, and Actions/CI — via the authenticated `gh` CLI. Use whenever the task involves GitHub (open/review/merge PRs, manage issues, clone repos, check CI runs, cut releases, or call the GitHub API).
---

# GitHub (via the `gh` CLI)

Use the authenticated `gh` CLI for all GitHub work. Verify access first with
`gh auth status` (or ensure `GH_TOKEN`/`GITHUB_TOKEN` is set in the environment).

## Common operations
- **Repos**: `gh repo view <owner>/<repo>`, `gh repo clone <owner>/<repo>`.
- **Pull requests**: `gh pr list`, `gh pr view <n> --comments`, `gh pr diff <n>`,
  `gh pr checkout <n>`, `gh pr create --base <branch> --title "…" --body-file <f>`,
  `gh pr merge <n> --squash`.
- **Issues**: `gh issue list`, `gh issue view <n>`, `gh issue create --title "…" --body-file <f>`,
  `gh issue comment <n> --body "…"`.
- **CI / Actions**: `gh run list`, `gh run view <id> --log-failed`, `gh run watch <id>`.
- **Releases**: `gh release create <tag> --notes-file <f>`.
- **Raw API** (anything not covered): `gh api repos/<owner>/<repo>/…`.

## Rules
- Confirm the target repo (`gh repo view`) before any destructive op (merge, close,
  delete, force-push).
- Pass multi-line bodies via `--body-file` or a heredoc file — never fragile inline quoting.
- Never push directly to the default branch: create a branch and open a PR.
- Prefer `--json <fields> --jq '…'` for machine-readable output you need to parse.

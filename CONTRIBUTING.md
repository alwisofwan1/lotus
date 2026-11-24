# Contributing

Thanks for helping with Lotus.

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Fork the repo and make your change on a branch.
3. Run the tests for the part you changed (see `README.md` → Commands):
   `bun run test`, `bun run host:test`, or `bun run pocket:test`.
4. Open a pull request. Describe what changed and how you tested it.

Do not run `bun install` at the repo root. Use `bun run install:all` (see `CLAUDE.md`).

By contributing, you agree that your contribution is licensed under the MIT License (`LICENSE`).

Enable the privacy hooks once per clone: `git config core.hooksPath .githooks`.

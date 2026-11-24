/**
 * Which build of this host is running — the one question no surface could answer.
 *
 * `GET /health` carried `version: "0.1.0"`, hardcoded and never once changed, so it was
 * decoration rather than a version. `hostCaps.features` was the only thing that actually
 * moved per build, and it *implies* an age instead of stating one: reading it takes somebody
 * who remembers which feature landed on which day.
 *
 * That cost real time on 2026-09-10. A VPS ran a binary four days old for days; the operator
 * read it as "the VPS is far behind" and reasoned towards migrating to
 * `@anthropic-ai/claude-agent-sdk`. The truth — a stale binary — was only found by putting two
 * hosts side by side and noticing a feature pair that the current code cannot produce apart.
 *
 * **Baked at compile time, so it cannot lie.** `bun build --define` replaces this identifier
 * with a literal, so the built artefact has no lookup left for anyone to override. A runtime
 * env var would have been cheaper and would have let a deploy script claim any build it liked.
 *
 * **A global identifier, not `process.env[…]`** — probed against Bun 1.3.13 on 2026-09-11,
 * because the first cut used the env form and silently did not substitute: the built binary
 * still contained the lookup and every artefact would have reported `dev`. `--define` matches
 * the expression textually, and a bracket access is not the expression it is given.
 *
 * `typeof` rather than a bare read, because from source the identifier is not declared at all
 * and anything else would throw.
 *
 * **`dev` is the honest answer from source**, not a failure and not a guess. A semver nobody
 * remembers to raise is exactly what `"0.1.0"` already was, so this is `git describe` plus the
 * commit date: both move on their own.
 */
declare const LOTUS_BUILD_ID: string | undefined;

export const BUILD_ID: string =
  typeof LOTUS_BUILD_ID === "string" && LOTUS_BUILD_ID.length > 0 ? LOTUS_BUILD_ID : "dev";

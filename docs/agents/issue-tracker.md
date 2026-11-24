# Issue tracker: GitHub Issues

Issues and specs for this repo live in GitHub Issues on this repository.

- One issue per bug or feature. A larger feature gets a parent issue with a task list of child issues.
- Triage state is a label (see `triage-labels.md` for the strings).
- Discussion happens in the issue comments.

## When a skill says "publish to the issue tracker"

Create an issue with `gh issue create`, and add the triage label.

## When a skill says "fetch the relevant ticket"

Read it with `gh issue view <number> --comments`.

## Not the issue tracker

`docs/adr/` holds architecture decision records, not tickets. An ADR is the outcome of a decision;
never file a ticket there.

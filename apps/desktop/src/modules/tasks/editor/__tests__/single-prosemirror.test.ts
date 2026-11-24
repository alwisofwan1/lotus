import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every ProseMirror package must see ONE `prosemirror-model`.
 *
 * Two copies — even at the same version — are two `Fragment` classes, and the editor dies the
 * first time a command built by one meets a node built by the other: "Can not convert <> to a
 * Fragment (looks like multiple versions of prosemirror-model were loaded)", on the first toolbar
 * click. The lockfile asked for one copy; a `node_modules` left over from an install that was
 * interrupted mid-downgrade held eleven. Nothing short of clicking a button in the running app
 * showed it — so this checks the tree itself.
 */

const require = createRequire(import.meta.url);

const DEPENDENTS = [
  // Each package by its main entry; resolution walks up from there through its own folder, so a
  // copy nested inside it is found first — exactly what the bundler does. TipTap's re-export is
  // what every TipTap extension builds its nodes with.
  "@tiptap/pm/model",
  "prosemirror-state",
  "prosemirror-transform",
  "prosemirror-commands",
  "prosemirror-view",
  "prosemirror-schema-list",
  "prosemirror-tables",
  "prosemirror-markdown",
];

function modelSeenFrom(pkg: string): string {
  const from = createRequire(join(dirname(require.resolve(pkg)), "_.js"));
  return from.resolve("prosemirror-model");
}

describe("the ProseMirror dependency tree", () => {
  it("resolves every package to the same prosemirror-model", () => {
    const seen = new Set(DEPENDENTS.map(modelSeenFrom));
    expect([...seen]).toEqual([require.resolve("prosemirror-model")]);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const personaCss = readFileSync(
  resolve(process.cwd(), "src/styles/canvas/agent-node-persona-nl.css"),
  "utf8",
);
const barCss = readFileSync(
  resolve(process.cwd(), "src/styles/canvas/canvas-nl-bar.css"),
  "utf8",
);

describe("classic dictation review styling", () => {
  it("does not reserve a separate review action strip above the command field", () => {
    expect(personaCss).not.toContain(".canvas-nl-review");
    expect(barCss).not.toContain(".canvas-nl-review");
  });
});

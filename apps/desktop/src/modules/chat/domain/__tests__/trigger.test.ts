import { describe, expect, it } from "vitest";

import { activeTrigger } from "../trigger";

describe("activeTrigger", () => {
  it.each([
    ["/", { char: "/", query: "", from: 0 }],
    ["/lo", { char: "/", query: "lo", from: 0 }],
    ["review with /code-re", { char: "/", query: "code-re", from: 12 }],
    ["fix @chat", { char: "@", query: "chat", from: 4 }],
    ["see (@src/a.ts", { char: "@", query: "src/a.ts", from: 5 }],
    ["line one\n@x", { char: "@", query: "x", from: 9 }],
    ["hi @", { char: "@", query: "", from: 3 }],
  ])("%j opens", (text, want) => {
    expect(activeTrigger(text)).toEqual(want);
  });

  it.each(["/lo ", "mail a@b.com", "http://x/y", "src/a", "plain text", "", "@a b"])("%j does not", (text) => {
    expect(activeTrigger(text)).toBeNull();
  });

  it("reads only the end of a long draft", () => {
    const long = "x".repeat(300);
    expect(activeTrigger(`${long} @fi`)).toEqual({ char: "@", query: "fi", from: 301 });
    // The `@` sits at the window's cut: what came before it is unknown, so it is not trusted.
    expect(activeTrigger(`a${"@".padEnd(256, "y")}`)).toBeNull();
  });
});

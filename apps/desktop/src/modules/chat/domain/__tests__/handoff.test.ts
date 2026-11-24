import { describe, expect, it } from "vitest";

import { splitHandoff } from "../handoff";

describe("a chat continued from another agent", () => {
  it("splits the seed from what the user typed", () => {
    const seed = '<lotus-handoff chat="c1" from="claude">\nThis continues the chat "Fix login".\n\nUser: hi\n</lotus-handoff>';
    expect(splitHandoff(`${seed}\n\nship it`)).toEqual({
      handoff: { chatId: "c1", from: "claude", context: 'This continues the chat "Fix login".\n\nUser: hi' },
      text: "ship it",
    });
  });

  it("leaves an ordinary message alone", () => {
    expect(splitHandoff("hello <lotus-handoff>")).toEqual({ handoff: null, text: "hello <lotus-handoff>" });
  });
});

import React from "react";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { chatFontStyle, setChatFont, useChatFont } from "../chat-font";

function Probe() {
  return <span data-testid="font">{useChatFont()}</span>;
}

describe("chat font", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to Inter, ignores an unknown saved value, and follows a change at once", () => {
    localStorage.setItem("lotus.chat.font", "comic");
    render(<Probe />);
    expect(screen.getByTestId("font").textContent).toBe("inter");
    act(() => setChatFont("serif"));
    expect(screen.getByTestId("font").textContent).toBe("serif");
    expect(localStorage.getItem("lotus.chat.font")).toBe("serif");
  });

  it("gives each face its stack and size step", () => {
    expect(chatFontStyle("serif")).toMatchObject({ "--chat-read-font": expect.stringContaining("Source Serif"), "--chat-read-scale": 1.08 });
  });
});

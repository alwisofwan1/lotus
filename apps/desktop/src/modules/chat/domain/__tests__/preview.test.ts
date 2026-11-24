import { describe, expect, it } from "vitest";

import { addPick, addressOf, cropOf, externalTarget, detectedServer, pickFrom, pickPlace, splitPicks, touchBrowser, withPicks, type Pick } from "../preview";
import type { ThreadState } from "../thread-state";

const state = (...items: object[]) => ({ turns: [{ items: items.map((item) => ({ item })) }] }) as unknown as ThreadState;

describe("detectedServer", () => {
  it("takes the newest local address the agent ran or said", () => {
    const s = state(
      { id: "a", kind: "command", status: "completed", command: "bun run dev", description: null, output: "  ➜  Local:   http://localhost:5173/\n" },
      { id: "b", kind: "agentMessage", status: "completed", text: "It runs on http://0.0.0.0:3000/login." },
    );
    expect(detectedServer(s)).toEqual({ url: "http://localhost:3000/login", command: null });
    expect(detectedServer(state(s.turns[0].items[0].item))).toEqual({ url: "http://localhost:5173/", command: "bun run dev" });
  });

  it("ignores addresses that are not this machine", () => {
    expect(detectedServer(state({ id: "a", kind: "agentMessage", status: "completed", text: "See https://example.com:3000" }))).toBeNull();
    expect(detectedServer(null)).toBeNull();
  });
});

describe("addressOf", () => {
  it("makes a local address http and the rest https", () => {
    expect(addressOf(" localhost:3000/login ")).toBe("http://localhost:3000/login");
    expect(addressOf("example.com")).toBe("https://example.com");
    expect(addressOf("http://a.test")).toBe("http://a.test");
    expect(addressOf("  ")).toBeNull();
  });
  it("keeps a local file as it is", () => {
    expect(addressOf("file:///repo/mockups/a.html")).toBe("file:///repo/mockups/a.html");
  });
});

describe("touchBrowser", () => {
  it("keeps the three used last and closes the oldest", () => {
    expect(touchBrowser(["a", "b"], "a")).toEqual({ loaded: ["b", "a"], evicted: [] });
    expect(touchBrowser(["a", "b", "c"], "d")).toEqual({ loaded: ["b", "c", "d"], evicted: ["a"] });
  });
});

describe("picks", () => {
  const pick: Pick = {
    ...pickFrom({ id: "p", url: "http://localhost:3000/login", selector: "form > button", label: "button: Sign in", text: " Sign\n in ", summary: ["element: button"], boundingBox: { x: 1, y: 2, width: 120, height: 34 }, visualAttachments: [{ name: "x", content: "https://not-data" }] })!,
    attachments: [],
  };
  const picture = { path: "/t/logo.png", name: "logo.png", mimeType: "image/png", size: 1 } as unknown as Pick["attachments"][number];

  it("reads the overlay's report", () => {
    expect(pickFrom({ label: "no page" })).toBeNull();
    expect(pick).toMatchObject({ tag: "button", text: "Sign in", images: [] });
    expect(pickFrom({ url: "u", label: "img" })!.tag).toBe("img");
    expect(pickPlace(pick)).toBe("localhost:3000/login");
  });

  it("cuts the screenshot where the element is on screen, not on the page", () => {
    const viewport = { width: 800, height: 600, scrollX: 0, scrollY: 300 };
    expect(cropOf({ boundingBox: { x: 10, y: 320, width: 100, height: 40 }, viewport })).toEqual({ x: 10, y: 20, width: 100, height: 40, viewportWidth: 800, viewportHeight: 600 });
    expect(cropOf({ boundingBox: { x: 10, y: 320, width: 0, height: 40 }, viewport })).toBeNull();
    expect(cropOf({ boundingBox: { x: 10, y: 320, width: 100, height: 40 } })).toBeNull();
  });

  it("keeps one pick per report and per element", () => {
    // The overlay reports a pick four times under one id; the last copy carries its pictures.
    let list = addPick([], pick);
    list = addPick(list, pick);
    list = addPick(list, { ...pick, attachments: [picture] });
    list = addPick(list, pick);
    expect(list).toHaveLength(1);
    expect(list[0].attachments).toEqual([picture]);
    // The same element picked again replaces the older pick.
    list = addPick(list, { ...pick, id: "q" });
    expect(list.map((p) => p.id)).toEqual(["q"]);
    expect(addPick(list, { ...pick, id: "r", selector: "h1" })).toHaveLength(2);
  });

  it("sends one line per pick and reads it back for the chip", () => {
    const text = withPicks("Make it full width", [{ ...pick, text: 'Say "hi" <now>', attachments: [picture] }]);
    expect(text).toBe(
      '<picked-elements>\n<pick page="http://localhost:3000/login" selector="form > button" element="button" text="Say &quot;hi&quot; &lt;now>" box="1,2 120x34" pictures="1 attached" />\n</picked-elements>\n\nMake it full width',
    );
    expect(splitPicks(text)).toEqual({
      picks: [{ url: "http://localhost:3000/login", selector: "form > button", tag: "button", text: 'Say "hi" <now>' }],
      text: "Make it full width",
    });
    expect(withPicks("hi", [])).toBe("hi");
    expect(splitPicks("plain <picked-elements>")).toEqual({ picks: [], text: "plain <picked-elements>" });
  });

  it("sends the design details: component, styles and HTML", () => {
    const designed: Pick = {
      ...pickFrom({
        url: "http://localhost:3000/",
        selector: "button",
        label: "button",
        computedStyles: { color: "rgb(0, 0, 0)", "font-size": "14px" },
        outerHTML: ' <button class="cta">Go</button> ',
        reactComponent: "SignInButton",
      })!,
      attachments: [],
    };
    expect(designed).toMatchObject({ component: "SignInButton", styles: "color: rgb(0, 0, 0); font-size: 14px", html: '<button class="cta">Go</button>' });
    const line = withPicks("", [designed]);
    expect(line).toContain('component="SignInButton" styles="color: rgb(0, 0, 0); font-size: 14px" html="&lt;button class=&quot;cta&quot;>Go&lt;/button>"');
    // The chip reads back the same as before.
    expect(splitPicks(line).picks).toEqual([{ url: "http://localhost:3000/", selector: "button", tag: "button", text: null }]);
    // An older overlay sends none of them.
    expect(pick).toMatchObject({ component: null, styles: null, html: null });
  });
});

describe("externalTarget", () => {
  it("sends a web page as its address and a local page as its decoded path", () => {
    expect(externalTarget("http://localhost:3000/a")).toEqual({ kind: "web", url: "http://localhost:3000/a" });
    expect(externalTarget("file:///Users/me/my%20demo/fps-game.html")).toEqual({ kind: "file", path: "/Users/me/my demo/fps-game.html" });
    expect(externalTarget("javascript:alert(1)")).toBeNull();
    expect(externalTarget("not a url")).toBeNull();
  });
});

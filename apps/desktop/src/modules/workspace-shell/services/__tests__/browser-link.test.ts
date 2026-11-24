import { describe, expect, it } from "vitest";
import { browserOwner, hostsOf, monogram, shortAddress, typedPart, withBrowserPicks } from "@/modules/workspace-shell/services/browser-link";

const nia = { id: "nia", name: "Nia" };
const lyra = { id: "lyra", name: "Lyra" };
const tails: Record<string, string> = {
  nia: "● bun dev → http://localhost:3000\n",
  // Vite's banner: the port in bold.
  lyra: "  ➜  Local:   http://localhost:\x1b[1m5173\x1b[22m/\n",
};
const tail = (id: string) => tails[id] ?? null;

describe("browserOwner", () => {
  it("keeps the chosen link", () => {
    expect(browserOwner({ linkedPaneId: "lyra", url: "http://localhost:3000", agents: [nia, lyra], tail })).toBe(lyra);
  });

  it("gives nobody when the linked agent has closed, never a guess", () => {
    expect(browserOwner({ linkedPaneId: "gone", url: "http://localhost:3000", agents: [nia, lyra], tail })).toBeNull();
  });

  it("unlinked: the agent that printed the address, through ANSI and loopback aliases", () => {
    expect(browserOwner({ url: "http://127.0.0.1:3000/pricing", agents: [lyra, nia], tail })).toBe(nia);
    expect(browserOwner({ url: "http://localhost:5173/admin", agents: [nia, lyra], tail })).toBe(lyra);
  });

  it("unlinked and unnamed anywhere: nobody", () => {
    expect(browserOwner({ url: "https://example.com", agents: [nia, lyra], tail })).toBeNull();
    expect(browserOwner({ url: "", agents: [nia, lyra], tail })).toBeNull();
  });
});

describe("hostsOf / monogram", () => {
  it("names a local server by every loopback alias, a site by its host", () => {
    expect(hostsOf("http://localhost:3000/x")).toContain("127.0.0.1:3000");
    expect(hostsOf("https://example.com/a")).toEqual(["example.com"]);
  });

  it("names a browser short: a local port, else the host", () => {
    expect(shortAddress("http://localhost:3000/pricing")).toBe(":3000");
    expect(shortAddress("https://example.com/a")).toBe("example.com");
    expect(shortAddress("")).toBe("page");
  });

  it("marks an agent by its first letter", () => {
    expect(monogram(" lyra 2")).toBe("L");
    expect(monogram("")).toBe("?");
  });
});

describe("withBrowserPicks", () => {
  const pick = {
    id: "p1",
    url: "http://localhost:5173/admin",
    selector: "table.users",
    tag: "table",
    text: "Users",
    images: [],
    box: null,
    attachments: [{ kind: "image" as const, path: "/s/table.png", name: "table.png", mimeType: "image/png", sizeBytes: 1 }],
  };

  it("names the element and its screenshot path, then the note", () => {
    const message = withBrowserPicks("add a role column", [pick], false);
    expect(message).toContain('selector="table.users"');
    expect(message).toContain("/s/table.png");
    expect(message.endsWith("add a role column\n\n(element screenshots: /s/table.png)")).toBe(true);
  });

  it("is one line for a terminal agent", () => {
    expect(withBrowserPicks("fix", [pick], true)).not.toContain("\n");
  });

  it("leaves a message without picks alone", () => {
    expect(withBrowserPicks("hi", [], true)).toBe("hi");
  });
});

describe("typedPart", () => {
  it("takes the picks and screenshot paths off a sent message, in either form", () => {
    const pick = { id: "p", url: "https://g.com/", selector: "#logo", tag: "img", text: null, images: [], box: null, attachments: [{ kind: "image" as const, path: "/s/a.png", name: "a.png", mimeType: "image/png", sizeBytes: 1 }] };
    expect(typedPart(withBrowserPicks("apa ini ?", [pick], true))).toBe("apa ini ?");
    expect(typedPart(withBrowserPicks("apa ini ?", [pick], false))).toBe("apa ini ?");
    expect(typedPart("plain")).toBe("plain");
  });
});

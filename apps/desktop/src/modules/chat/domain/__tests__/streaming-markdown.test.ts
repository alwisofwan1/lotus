import { describe, expect, it } from "vitest";
import { holdTableHead, splitStreamingMarkdown } from "../streaming-markdown";

describe("splitStreamingMarkdown", () => {
  it("settles everything before the last blank line", () => {
    const text = "# Title\n\nFirst paragraph.\n\nSecond, still wri";
    const { settled, tail } = splitStreamingMarkdown(text);
    expect(settled).toBe("# Title\n\nFirst paragraph.\n");
    expect(tail).toBe("\nSecond, still wri");
    expect(settled + tail).toBe(text);
  });

  it("keeps an open code fence in the tail, blank lines and all", () => {
    const text = "Intro.\n\n```ts\nconst a = 1;\n\nconst b";
    expect(splitStreamingMarkdown(text).settled).toBe("Intro.\n");
  });

  it("settles a closed fence once a blank line follows it", () => {
    const text = "~~~~\na\n\n~~~ not a close\n~~~~\n\nNext";
    expect(splitStreamingMarkdown(text)).toEqual({ settled: "~~~~\na\n\n~~~ not a close\n~~~~\n", tail: "\nNext" });
  });

  it("settles nothing in a single block", () => {
    expect(splitStreamingMarkdown("one line")).toEqual({ settled: "", tail: "one line" });
  });
});

describe("holdTableHead", () => {
  it("holds a table's pipe lines until the row after its delimiter starts", () => {
    expect(holdTableHead("Intro\n| File | Ba")).toBe("Intro");
    expect(holdTableHead("Intro\n| File | Baris |\n|---|--")).toBe("Intro");
    expect(holdTableHead("Intro\n| File | Baris |\n|---|---|")).toBe("Intro");
    expect(holdTableHead("| File | Baris |\n|---|---|\n")).toBe("| File | Baris |\n|---|---|\n");
    expect(holdTableHead("| File | Baris |\n|---|---|\n| a.ts | 1")).toBe("| File | Baris |\n|---|---|\n| a.ts | 1");
  });

  it("leaves text without a trailing pipe run alone", () => {
    expect(holdTableHead("plain words\n")).toBe("plain words\n");
    expect(holdTableHead("plain words")).toBe("plain words");
  });
});

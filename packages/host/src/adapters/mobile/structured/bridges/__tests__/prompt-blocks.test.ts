import { describe, expect, it } from "vitest";

import type { PromptAttachment } from "../../../../../types/provider-bridge.js";
import { acpPrompt, claudeContent, codexInput } from "../prompt-blocks.js";

const image: PromptAttachment = { kind: "image", path: "/s/t/abc.png", name: "shot.png", mimeType: "image/png", sizeBytes: 3 };
const file: PromptAttachment = { kind: "file", path: "/s/t/def.log", name: "run.log", mimeType: "text/plain", sizeBytes: 12 };
const read = () => Buffer.from("img");

describe("claudeContent", () => {
  it("is the plain text block when nothing is attached", () => {
    expect(claudeContent("hi", [], read)).toEqual([{ type: "text", text: "hi" }]);
  });

  it("sends images as pictures and other files as a line naming their path, text last", () => {
    expect(claudeContent("look", [image, file], read)).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("img").toString("base64") } },
      { type: "text", text: "[Attached file run.log (text/plain, 12 bytes). It is on disk at /s/t/def.log — use the Read tool to view it.]" },
      { type: "text", text: "look" },
    ]);
  });
});

describe("codexInput", () => {
  it("names images by path and files by a line", () => {
    expect(codexInput("look", [image, file])).toEqual([
      { type: "text", text: "look", text_elements: [] },
      { type: "localImage", path: "/s/t/abc.png" },
      { type: "text", text: "[Attached file run.log. It is on disk at /s/t/def.log — read it there.]", text_elements: [] },
    ]);
  });
});

describe("acpPrompt", () => {
  it("sends images inline and files as a line", () => {
    expect(acpPrompt("", [image, file], read)).toEqual([
      { type: "image", mimeType: "image/png", data: Buffer.from("img").toString("base64") },
      { type: "text", text: "[Attached file run.log. It is on disk at /s/t/def.log — read it there.]" },
    ]);
  });
});

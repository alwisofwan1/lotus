import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { readBody, readJson } from "../utils.js";

function feed(chunks: (string | Buffer)[]): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  setImmediate(() => {
    for (const chunk of chunks) req.emit("data", chunk);
    req.emit("end");
  });
  return req;
}

describe("readJson", () => {
  it("parses a JSON object body", async () => {
    await expect(readJson(feed(['{"a":', "1}"]))).resolves.toEqual({ a: 1 });
  });

  it("rejects invalid JSON", async () => {
    await expect(readJson(feed(["{not json"]))).rejects.toThrow("Invalid JSON body");
  });

  /**
   * The mobile façade listens on a tailnet address, so every byte here arrives from
   * another device. Without a cap this accumulated a string until the process died —
   * harmless while bodies were pairing codes and prompts, a hole the moment audio
   * uploads exist.
   */
  it("stops reading once the body exceeds the cap", async () => {
    const oversized = "x".repeat(50);

    await expect(readJson(feed([`"${oversized}"`]), 16)).rejects.toThrow("Body too large");
  });

  it("does not reject a body that merely reaches the cap", async () => {
    const body = '{"a":1}';

    await expect(readJson(feed([body]), body.length)).resolves.toEqual({ a: 1 });
  });
});

describe("readBody UTF-8", () => {
  it.each(["é", "日本語", "😀"])("preserves %s split between bytes", async (text) => {
    const body = Buffer.from(JSON.stringify({ text }));
    const chunks = Array.from(body, (byte) => Buffer.from([byte]));
    await expect(readJson(feed(chunks))).resolves.toEqual({ text });
  });

  it("counts original bytes at the cap even when a character is split", async () => {
    await expect(readBody(feed([Buffer.from([0xc3]), Buffer.from([0xa9])]), 2)).resolves.toBe("é");
  });

  it("rejects a buffer body over the byte cap", async () => {
    await expect(readBody(feed([Buffer.from("é")]), 1)).rejects.toThrow("Body too large");
  });
});

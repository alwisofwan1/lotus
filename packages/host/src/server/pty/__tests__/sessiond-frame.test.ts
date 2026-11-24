import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, MAX_FRAME } from "../sessiond-frame.js";

describe("sessiond frames", () => {
  it("round-trips a header and a binary payload", () => {
    const payload = Buffer.from([0, 255, 27, 10]);
    const [frame] = new FrameDecoder().push(encodeFrame({ t: "write", id: "s1" }, payload));
    expect(frame?.header).toEqual({ t: "write", id: "s1" });
    expect(frame?.payload).toEqual(payload);
  });

  it("matches the Rust layout byte for byte", () => {
    // u32 BE header length, JSON, u32 BE payload length, payload (proto.rs write_frame).
    expect([...encodeFrame({ t: "x" }, Buffer.from("ab"))]).toEqual([
      0, 0, 0, 9, ...Buffer.from('{"t":"x"}'), 0, 0, 0, 2, 97, 98,
    ]);
  });

  it("reassembles frames however the socket chunks them", () => {
    const bytes = Buffer.concat([encodeFrame({ t: "a" }, Buffer.from("one")), encodeFrame({ t: "b" })]);
    const decoder = new FrameDecoder();
    const seen = [];
    for (const byte of bytes) seen.push(...decoder.push(Buffer.from([byte])));
    expect(seen.map((f) => [f.header.t, f.payload.toString()])).toEqual([["a", "one"], ["b", ""]]);
  });

  it("refuses an oversized frame before buffering it", () => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(MAX_FRAME + 1, 0);
    expect(() => new FrameDecoder().push(head)).toThrow(/exceeds/);
    expect(() => encodeFrame({ t: "write" }, new Uint8Array(MAX_FRAME))).toThrow(/exceeds/);
  });

  it("refuses a header that is not a message", () => {
    expect(() => new FrameDecoder().push(encodeFrame([1, 2]))).toThrow(/not a message/);
  });
});

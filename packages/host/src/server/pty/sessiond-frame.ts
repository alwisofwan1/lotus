/// Wire protocol v1 of `lotus-sessiond` (ADR-0067), mirrored from `crates/lotus-sessiond/src/proto.rs`.

export const PROTO_VERSION = 1;
/// Header plus payload; the daemon refuses anything larger, and so do we.
export const MAX_FRAME = 8 * 1024 * 1024;

export interface Owner {
  pane_id: string | null;
  canvas_terminal_id: string | null;
  window_label: string;
}

export interface SpawnSpec {
  argv: string[];
  env: [string, string][];
  cwd: string | null;
  cols: number;
  rows: number;
  owner: Owner;
  /** Opaque to the daemon, handed back by `list`. */
  tag?: string;
}

export interface SessionInfo {
  id: string;
  owner: Owner;
  cols: number;
  rows: number;
  total_bytes: number;
  idle: boolean;
  started_ago_ms: number;
  pid: number | null;
  cwd?: string;
  tag?: string;
}

/** A decoded header: JSON whose `t` names the message. Fields are narrowed where read. */
export type Header = { t: string } & Record<string, unknown>;

export interface Frame {
  header: Header;
  payload: Buffer;
}

export function encodeFrame(header: object, payload: Uint8Array = new Uint8Array()): Buffer {
  const head = Buffer.from(JSON.stringify(header));
  if (head.length + payload.length > MAX_FRAME) {
    throw new Error(`frame of ${head.length + payload.length} bytes exceeds ${MAX_FRAME}`);
  }
  const out = Buffer.alloc(8 + head.length + payload.length);
  out.writeUInt32BE(head.length, 0);
  head.copy(out, 4);
  out.writeUInt32BE(payload.length, 4 + head.length);
  out.set(payload, 8 + head.length);
  return out;
}

/// Splits a byte stream into frames, however the socket happened to chunk it.
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      if (this.buf.length < 4) break;
      const headLen = this.buf.readUInt32BE(0);
      if (headLen > MAX_FRAME) throw new Error(`frame header of ${headLen} bytes exceeds ${MAX_FRAME}`);
      if (this.buf.length < 8 + headLen) break;
      const payloadLen = this.buf.readUInt32BE(4 + headLen);
      if (headLen + payloadLen > MAX_FRAME) {
        throw new Error(`frame of ${headLen + payloadLen} bytes exceeds ${MAX_FRAME}`);
      }
      const end = 8 + headLen + payloadLen;
      if (this.buf.length < end) break;
      const header: unknown = JSON.parse(this.buf.subarray(4, 4 + headLen).toString("utf8"));
      if (typeof header !== "object" || header === null || typeof (header as Header).t !== "string") {
        throw new Error("frame header is not a message");
      }
      // Copied: the payload outlives this buffer, which the next push replaces.
      frames.push({ header: header as Header, payload: Buffer.from(this.buf.subarray(8 + headLen, end)) });
      this.buf = this.buf.subarray(end);
    }
    return frames;
  }
}

/**
 * Block-based ring buffer that accumulates PTY output while the terminal pane
 * is hidden. Unlike a single large string, the ring evicts *whole blocks* on
 * overflow so that the oldest data is always sacrificed first and the emitted
 * overflow notice can accurately say "some lines were dropped" rather than
 * having to emit a full terminal hard-reset (\x1bc) that would wipe scrollback.
 *
 * On drain, if blocks were evicted since the last drain the ring emits a dim
 * notice and then skips to the next newline boundary in the oldest retained
 * block to avoid writing a partial line that begins mid-ANSI-sequence.
 */

const DEFAULT_BLOCK_SIZE = 16 * 1024; // 16 KB
const DEFAULT_MAX_BLOCKS = 64;        // 1 MB total cap

export const DORMANT_RING_OVERFLOW_NOTICE =
  "\x1b[2m[output backlog full; some lines were dropped]\x1b[0m\r\n";

export interface DormantRingOptions {
  /** Bytes per block. Default: 16 384 (16 KB). */
  blockSize?: number;
  /** Maximum number of blocks retained. Default: 64 (= 1 MB). */
  maxBlocks?: number;
}

export class TerminalDormantRing {
  private readonly blockSize: number;
  private readonly maxBlocks: number;

  private blocks: string[] = [];
  /** Accumulates data until blockSize is reached, then flushes to blocks[]. */
  private current = "";
  /** Whether any block was evicted since the last drain. */
  private overflowed = false;
  private dropCount = 0;

  constructor(options?: DormantRingOptions) {
    this.blockSize = options?.blockSize ?? DEFAULT_BLOCK_SIZE;
    this.maxBlocks = options?.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  }

  append(data: string): void {
    if (!data) return;
    this.current += data;
    // Seal complete blocks from the current accumulator.
    while (this.current.length >= this.blockSize) {
      const block = this.current.slice(0, this.blockSize);
      this.current = this.current.slice(this.blockSize);
      this.pushBlock(block);
    }
  }

  drain(write: (chunk: string) => void): void {
    // Snapshot sealed blocks and the partial accumulator. Do NOT push `current`
    // through pushBlock — that would count as a new eviction and corrupt the
    // overflow flag for data the caller is about to receive.
    const toWrite = this.blocks;
    this.blocks = [];
    if (this.current) {
      toWrite.push(this.current);
      this.current = "";
    }

    if (toWrite.length === 0) return;

    if (this.overflowed) {
      write(DORMANT_RING_OVERFLOW_NOTICE);
      this.overflowed = false;
      // Skip to the next line boundary in the oldest retained block to avoid
      // emitting a partial line whose ANSI prefix was in an evicted block.
      this.trimHead(toWrite);
    }

    for (const block of toWrite) {
      if (block) write(block);
    }
  }

  hasData(): boolean {
    return this.blocks.length > 0 || this.current.length > 0;
  }

  clear(): void {
    this.blocks = [];
    this.current = "";
    this.overflowed = false;
    this.dropCount = 0;
  }

  getDropCount(): number {
    return this.dropCount;
  }

  // ─── private ──────────────────────────────────────────────────────────────

  private pushBlock(block: string): void {
    this.blocks.push(block);
    if (this.blocks.length > this.maxBlocks) {
      this.blocks.shift();
      this.dropCount++;
      this.overflowed = true;
    }
  }

  private trimHead(blocks: string[]): void {
    if (blocks.length === 0) return;
    const head = blocks[0];
    const nl = head.indexOf("\n");
    if (nl === -1) {
      // No newline — entire block is an orphaned tail; drop it.
      blocks.shift();
    } else {
      blocks[0] = head.slice(nl + 1);
    }
  }
}

const DEFAULT_BLOCK_SIZE = 16 * 1024;
const DEFAULT_MAX_BLOCKS = 64;

export const TERMINAL_V2_OUTPUT_OVERFLOW_NOTICE =
  "\x1b[2m[terminal output backlog full; older lines were dropped]\x1b[0m\r\n";

export type TerminalV2OutputRingOptions = {
  blockSize?: number;
  maxBlocks?: number;
};

export class TerminalV2OutputRing {
  private readonly blockSize: number;
  private readonly maxBlocks: number;
  private blocks: string[] = [];
  private current = "";
  private overflowed = false;
  private dropCount = 0;

  constructor(options: TerminalV2OutputRingOptions = {}) {
    this.blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
    this.maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  }

  append(data: string): void {
    if (!data) return;
    this.current += data;
    while (this.current.length >= this.blockSize) {
      this.pushBlock(this.current.slice(0, this.blockSize));
      this.current = this.current.slice(this.blockSize);
    }
  }

  drain(write: (chunk: string) => void): void {
    const chunks = this.blocks;
    this.blocks = [];
    if (this.current) {
      chunks.push(this.current);
      this.current = "";
    }
    if (chunks.length === 0) return;

    if (this.overflowed) {
      write(TERMINAL_V2_OUTPUT_OVERFLOW_NOTICE);
      this.overflowed = false;
      this.trimToLineBoundary(chunks);
    }

    for (const chunk of chunks) {
      if (chunk) write(chunk);
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

  private pushBlock(block: string): void {
    this.blocks.push(block);
    if (this.blocks.length <= this.maxBlocks) return;
    this.blocks.shift();
    this.dropCount += 1;
    this.overflowed = true;
  }

  private trimToLineBoundary(chunks: string[]): void {
    while (chunks.length > 0) {
      const newlineIndex = chunks[0].indexOf("\n");
      if (newlineIndex >= 0) {
        chunks[0] = chunks[0].slice(newlineIndex + 1);
        return;
      }
      chunks.shift();
    }
  }
}

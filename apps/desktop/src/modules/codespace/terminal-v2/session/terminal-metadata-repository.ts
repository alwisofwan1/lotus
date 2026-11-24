import type { TerminalV2MetadataSnapshot } from "../contracts/terminal-types";

export interface TerminalMetadataRepository {
  loadSnapshot(): Promise<TerminalV2MetadataSnapshot | null>;
}

export function createMemoryTerminalMetadataRepository(
  initialSnapshot: TerminalV2MetadataSnapshot | null = null,
): TerminalMetadataRepository {
  return {
    async loadSnapshot() {
      return initialSnapshot;
    },
  };
}

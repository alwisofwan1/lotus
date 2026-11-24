import type { CanvasImageRef } from "./canvas-intake";

/** Mirrors the Rust `agent_cli::ImageAttachment` (base64 data URL transport). */
export interface RunImageAttachment {
  name: string;
  content: string;
  mimeType?: string;
}

export interface SplitRunImages {
  /** Pasted bytes → base64 data-URL attachments staged by the Rust run path. */
  attachments: RunImageAttachment[];
  /** Dropped files already on disk → absolute paths passed straight through (no round-trip). */
  paths: string[];
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Split image refs into the two transports `agent_cli_run` accepts: base64 bytes and disk paths. */
export function splitImageRefs(refs: CanvasImageRef[]): SplitRunImages {
  const attachments: RunImageAttachment[] = [];
  const paths: string[] = [];
  for (const ref of refs) {
    if (ref.kind === "path") {
      paths.push(ref.path);
    } else {
      attachments.push({
        name: ref.name || basename("image"),
        content: `data:${ref.mime};base64,${ref.base64}`,
        mimeType: ref.mime,
      });
    }
  }
  return { attachments, paths };
}

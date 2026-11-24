import { Editor, type JSONContent } from "@tiptap/core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ticketEditorExtensions } from "@/modules/tasks/editor/ticket-editor-extensions";
import { editorCodec, snapshotSection, spliceSection } from "@/modules/tasks/editor/section-splice";

/**
 * The same contract against the REAL vault — in memory, nothing is written. Opt-in, because it
 * reads a personal folder and takes ~30s: `LOTUS_VAULT_PROBE=1 bunx vitest run section-splice.vault`.
 *
 * Measured when it was written (2026-09-24): 644 of 644 sections round-trip byte for byte, and
 * 614 of 614 one-word edits change only the block they were made in.
 */
const dir = join(process.env.HOME ?? "", "workspace/orbit-vault/tickets");
const enabled = process.env.LOTUS_VAULT_PROBE === "1" && existsSync(dir);

function sections(raw: string): string[] {
  const body = raw.replace(/^---[\s\S]*?\n---\n?/, "");
  return body.split(/^## .*$/m).map((s) => s.replace(/^\s*# .*\n/, "").trim()).filter(Boolean);
}

function firstText(nodes: JSONContent[]): JSONContent | null {
  for (const node of nodes) {
    if (node.type === "text" && node.text) return node;
    const hit = node.content && firstText(node.content);
    if (hit) return hit;
  }
  return null;
}

describe.skipIf(!enabled)("the real vault", () => {
  it("round-trips every section, and keeps every edit surgical", () => {
    const editor = new Editor({ extensions: ticketEditorExtensions("") });
    const { parse, serialize } = editorCodec(editor);
    const failures: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".md"))) {
      for (const section of sections(readFileSync(join(dir, file), "utf8"))) {
        const snapshot = snapshotSection(section, parse);
        const doc = parse(section);
        if (spliceSection(snapshot, doc, serialize) !== section) failures.push(`${file}: untouched section changed`);

        const edited = structuredClone(doc);
        const text = firstText(edited.slice(0, 1));
        if (!text) continue;
        text.text += " EDIT";
        const out = spliceSection(snapshot, edited, serialize);
        const first = snapshot.blocks.find((block) => !block.hidden)!;
        const tail = section.slice(section.indexOf(first.src) + first.src.length);
        if (!out.endsWith(tail)) failures.push(`${file}: an edit reached past its block`);
        for (const comment of section.match(/<!--[\s\S]*?-->/g) ?? []) {
          if (!out.includes(comment)) failures.push(`${file}: a comment was dropped`);
        }
      }
    }
    editor.destroy();
    expect(failures).toEqual([]);
  }, 300_000);
});

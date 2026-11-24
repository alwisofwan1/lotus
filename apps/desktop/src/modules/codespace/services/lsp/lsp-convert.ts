/*
 * LSP ↔ Monaco shapes. LSP counts lines and characters from 0, Monaco from 1; both count
 * characters in UTF-16 units, so a column is a character plus one.
 */

import type { editor, IMarkdownString, IRange, languages } from "monaco-editor";
import type {
  LspCompletionItem,
  LspDiagnostic,
  LspDocumentSymbol,
  LspHover,
  LspLocation,
  LspLocationLink,
  LspMarkedString,
  LspMarkupContent,
  LspPosition,
  LspRange,
  LspSymbolInformation,
  LspTextEdit,
  LspWorkspaceEdit,
} from "./lsp-types";
import { uriToPath } from "./lsp-client";

export type MonacoApi = typeof import("monaco-editor");

export function toLspPosition(position: { lineNumber: number; column: number }): LspPosition {
  return { line: position.lineNumber - 1, character: position.column - 1 };
}

export function toLspRange(range: IRange): LspRange {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  };
}

export function toMonacoRange(range: LspRange): IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

const SEVERITY: Record<number, number> = { 1: 8, 2: 4, 3: 2, 4: 1 };

export function toMarker(diagnostic: LspDiagnostic, monaco: Pick<MonacoApi, "Uri">): editor.IMarkerData {
  const range = toMonacoRange(diagnostic.range);
  const code = diagnostic.code === undefined
    ? undefined
    : diagnostic.codeDescription?.href
      ? { value: String(diagnostic.code), target: monaco.Uri.parse(diagnostic.codeDescription.href) }
      : String(diagnostic.code);
  return {
    ...range,
    severity: SEVERITY[diagnostic.severity ?? 1] ?? 8,
    message: diagnostic.message,
    source: diagnostic.source,
    code,
    tags: diagnostic.tags?.filter((tag) => tag === 1 || tag === 2),
    relatedInformation: diagnostic.relatedInformation?.flatMap((related) => {
      const path = uriToPath(related.location.uri);
      return path ? [{ resource: monaco.Uri.file(path), message: related.message, ...toMonacoRange(related.location.range) }] : [];
    }),
  };
}

/** A marker Monaco hands back (a code action's context) as the diagnostic it came from. */
export function markerToDiagnostic(marker: editor.IMarkerData): LspDiagnostic {
  const severity = marker.severity >= 8 ? 1 : marker.severity >= 4 ? 2 : marker.severity >= 2 ? 3 : 4;
  const code = typeof marker.code === "object" ? marker.code.value : marker.code;
  return {
    range: toLspRange(marker),
    severity,
    message: marker.message,
    ...(marker.source ? { source: marker.source } : {}),
    ...(code !== undefined ? { code } : {}),
  };
}

function markedToMarkdown(value: LspMarkedString): IMarkdownString {
  if (typeof value === "string") return { value };
  return { value: `\`\`\`${value.language}\n${value.value}\n\`\`\`` };
}

export function toMarkdown(content: string | LspMarkupContent | undefined): IMarkdownString | undefined {
  if (content === undefined) return undefined;
  if (typeof content === "string") return { value: content };
  if (content.kind === "plaintext") return { value: content.value.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&") };
  return { value: content.value };
}

export function toHover(hover: LspHover | null): languages.Hover | null {
  if (!hover) return null;
  const { contents } = hover;
  const parts = Array.isArray(contents)
    ? contents.map(markedToMarkdown)
    : typeof contents === "object" && "kind" in contents
      ? [toMarkdown(contents)!]
      : [markedToMarkdown(contents)];
  const shown = parts.filter((part) => part.value.trim() !== "");
  if (shown.length === 0) return null;
  return { contents: shown, ...(hover.range ? { range: toMonacoRange(hover.range) } : {}) };
}

/** Definition answers come as one location, a list, or links; all become plain locations. */
export function toLocations(
  result: LspLocation | LspLocation[] | LspLocationLink[] | null,
  monaco: Pick<MonacoApi, "Uri">,
): languages.Location[] {
  if (!result) return [];
  const list = (Array.isArray(result) ? result : [result]) as Array<LspLocation | LspLocationLink>;
  return list.flatMap((item) => {
    const uri = "targetUri" in item ? item.targetUri : item.uri;
    const range = "targetUri" in item ? item.targetSelectionRange ?? item.targetRange : item.range;
    const path = uriToPath(uri);
    return path ? [{ uri: monaco.Uri.file(path), range: toMonacoRange(range) }] : [];
  });
}

export function toTextEdits(edits: LspTextEdit[] | null | undefined): languages.TextEdit[] {
  return (edits ?? []).map((edit) => ({ range: toMonacoRange(edit.range), text: edit.newText }));
}

const COMPLETION_KIND: Record<number, number> = {
  1: 18, 2: 0, 3: 1, 4: 2, 5: 3, 6: 4, 7: 5, 8: 7, 9: 8, 10: 9, 11: 12, 12: 13, 13: 15,
  14: 17, 15: 27, 16: 19, 17: 20, 18: 21, 19: 23, 20: 16, 21: 14, 22: 6, 23: 10, 24: 11, 25: 24,
};

export type CompletionDefaults = {
  editRange?: LspRange | { insert: LspRange; replace: LspRange };
  insertTextFormat?: 1 | 2;
};

export function toCompletionItem(
  item: LspCompletionItem,
  fallbackRange: IRange,
  defaults: CompletionDefaults = {},
): languages.CompletionItem {
  let range: languages.CompletionItem["range"] = fallbackRange;
  let insertText = item.insertText ?? item.label;
  const edit = item.textEdit;
  if (edit) {
    insertText = edit.newText;
    range = "insert" in edit
      ? { insert: toMonacoRange(edit.insert), replace: toMonacoRange(edit.replace) }
      : toMonacoRange(edit.range);
  } else if (defaults.editRange) {
    insertText = item.textEditText ?? insertText;
    range = "insert" in defaults.editRange
      ? { insert: toMonacoRange(defaults.editRange.insert), replace: toMonacoRange(defaults.editRange.replace) }
      : toMonacoRange(defaults.editRange);
  }
  const snippet = (item.insertTextFormat ?? defaults.insertTextFormat) === 2;
  const deprecated = item.deprecated || item.tags?.includes(1);
  const description = item.labelDetails?.description;
  const labelDetail = item.labelDetails?.detail;
  return {
    label: labelDetail || description ? { label: item.label, detail: labelDetail, description } : item.label,
    kind: COMPLETION_KIND[item.kind ?? 1] ?? 18,
    detail: item.detail,
    documentation: toMarkdown(item.documentation),
    sortText: item.sortText,
    filterText: item.filterText,
    preselect: item.preselect,
    insertText,
    // 4 = InsertAsSnippet.
    insertTextRules: snippet ? 4 : undefined,
    range,
    commitCharacters: item.commitCharacters,
    additionalTextEdits: item.additionalTextEdits ? toTextEdits(item.additionalTextEdits) : undefined,
    tags: deprecated ? [1] : undefined,
  };
}

export function toDocumentSymbols(result: LspDocumentSymbol[] | LspSymbolInformation[] | null): languages.DocumentSymbol[] {
  if (!result || result.length === 0) return [];
  // 0-based in LSP, 0-based in Monaco's SymbolKind too, but LSP starts at File = 1.
  const kind = (value: number) => Math.max(0, value - 1);
  if ("location" in result[0]) {
    return (result as LspSymbolInformation[]).map((symbol) => ({
      name: symbol.name,
      detail: "",
      kind: kind(symbol.kind),
      tags: [],
      containerName: symbol.containerName,
      range: toMonacoRange(symbol.location.range),
      selectionRange: toMonacoRange(symbol.location.range),
    }));
  }
  const convert = (symbol: LspDocumentSymbol): languages.DocumentSymbol => ({
    name: symbol.name,
    detail: symbol.detail ?? "",
    kind: kind(symbol.kind),
    tags: [],
    range: toMonacoRange(symbol.range),
    selectionRange: toMonacoRange(symbol.selectionRange),
    children: symbol.children?.map(convert),
  });
  return (result as LspDocumentSymbol[]).map(convert);
}

/** Applies LSP edits to a text, as the server meant them: all against the text before any. */
export function applyTextEdits(text: string, edits: LspTextEdit[]): string {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === "\n") lineStarts.push(index + 1);
  const offset = ({ line, character }: LspPosition) => {
    if (line >= lineStarts.length) return text.length;
    const start = lineStarts[line];
    const end = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
    return Math.min(start + character, end);
  };
  const sorted = edits
    .map((edit, order) => ({ start: offset(edit.range.start), end: offset(edit.range.end), text: edit.newText, order }))
    .sort((a, b) => b.start - a.start || b.order - a.order);
  let result = text;
  for (const edit of sorted) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

/** The text edits per file a workspace edit makes. File creates, renames and deletes are refused. */
export function workspaceEditFiles(edit: LspWorkspaceEdit): { files: Map<string, LspTextEdit[]>; unsupported: boolean } {
  const files = new Map<string, LspTextEdit[]>();
  let unsupported = false;
  const add = (uri: string, edits: LspTextEdit[]) => {
    const path = uriToPath(uri);
    if (!path) {
      unsupported = true;
      return;
    }
    files.set(path, [...(files.get(path) ?? []), ...edits]);
  };
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change) add(change.textDocument.uri, change.edits);
      else unsupported = true;
    }
  } else if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) add(uri, edits);
  }
  return { files, unsupported };
}

/* The parts of the LSP 3.17 types the editor uses. Positions are 0-based, UTF-16. */

export type LspPosition = { line: number; character: number };
export type LspRange = { start: LspPosition; end: LspPosition };
export type LspLocation = { uri: string; range: LspRange };
export type LspLocationLink = {
  originSelectionRange?: LspRange;
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
};

export type LspTextEdit = { range: LspRange; newText: string };
export type LspInsertReplaceEdit = { newText: string; insert: LspRange; replace: LspRange };

export type LspTextDocumentEdit = {
  textDocument: { uri: string; version?: number | null };
  edits: LspTextEdit[];
};
export type LspResourceOperation = { kind: "create" | "rename" | "delete" };
export type LspWorkspaceEdit = {
  changes?: Record<string, LspTextEdit[]>;
  documentChanges?: Array<LspTextDocumentEdit | LspResourceOperation>;
};

export type LspMarkupContent = { kind: "markdown" | "plaintext"; value: string };
export type LspMarkedString = string | { language: string; value: string };

export type LspDiagnostic = {
  range: LspRange;
  severity?: 1 | 2 | 3 | 4;
  code?: string | number;
  codeDescription?: { href: string };
  source?: string;
  message: string;
  tags?: Array<1 | 2>;
  relatedInformation?: Array<{ location: LspLocation; message: string }>;
};

export type LspCommand = { title: string; command: string; arguments?: unknown[] };

export type LspCompletionItem = {
  label: string;
  labelDetails?: { detail?: string; description?: string };
  kind?: number;
  tags?: number[];
  detail?: string;
  documentation?: string | LspMarkupContent;
  deprecated?: boolean;
  preselect?: boolean;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: 1 | 2;
  textEdit?: LspTextEdit | LspInsertReplaceEdit;
  textEditText?: string;
  additionalTextEdits?: LspTextEdit[];
  commitCharacters?: string[];
  command?: LspCommand;
  data?: unknown;
};
export type LspCompletionList = {
  isIncomplete: boolean;
  itemDefaults?: { editRange?: LspRange | { insert: LspRange; replace: LspRange }; insertTextFormat?: 1 | 2; data?: unknown };
  items: LspCompletionItem[];
};

export type LspHover = { contents: LspMarkupContent | LspMarkedString | LspMarkedString[]; range?: LspRange };

export type LspSignatureHelp = {
  signatures: Array<{
    label: string;
    documentation?: string | LspMarkupContent;
    parameters?: Array<{ label: string | [number, number]; documentation?: string | LspMarkupContent }>;
    activeParameter?: number;
  }>;
  activeSignature?: number;
  activeParameter?: number;
};

export type LspDocumentSymbol = {
  name: string;
  detail?: string;
  kind: number;
  tags?: number[];
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
};
export type LspSymbolInformation = {
  name: string;
  kind: number;
  tags?: number[];
  location: LspLocation;
  containerName?: string;
};

export type LspCodeAction = {
  title: string;
  kind?: string;
  diagnostics?: LspDiagnostic[];
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: LspWorkspaceEdit;
  command?: LspCommand;
  data?: unknown;
};

export type LspDocumentHighlight = { range: LspRange; kind?: 1 | 2 | 3 };

export type LspTextDocumentSyncKind = 0 | 1 | 2;

export type LspServerCapabilities = {
  positionEncoding?: string;
  textDocumentSync?: LspTextDocumentSyncKind | {
    openClose?: boolean;
    change?: LspTextDocumentSyncKind;
    save?: boolean | { includeText?: boolean };
  };
  completionProvider?: { triggerCharacters?: string[]; resolveProvider?: boolean };
  hoverProvider?: boolean | object;
  signatureHelpProvider?: { triggerCharacters?: string[]; retriggerCharacters?: string[] };
  definitionProvider?: boolean | object;
  typeDefinitionProvider?: boolean | object;
  implementationProvider?: boolean | object;
  referencesProvider?: boolean | object;
  documentHighlightProvider?: boolean | object;
  documentSymbolProvider?: boolean | object;
  codeActionProvider?: boolean | { codeActionKinds?: string[]; resolveProvider?: boolean };
  documentFormattingProvider?: boolean | object;
  documentRangeFormattingProvider?: boolean | object;
  renameProvider?: boolean | { prepareProvider?: boolean };
  executeCommandProvider?: { commands: string[] };
};

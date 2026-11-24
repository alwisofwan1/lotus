/*
 * The editor's language servers: one per language per project (`editor_lsp.rs` picks the
 * project folder), shared by every pane showing its files. A Monaco model is attached to its
 * server when a pane shows it and detached when the model goes. Editor features (hover,
 * completion, go to definition…) are registered per server for the languages it serves, and
 * answer only for models attached to it.
 */

import type { editor, IDisposable, languages, CancellationToken, Position } from "monaco-editor";
import type { CodeSpaceStoredWorkspaceLocation } from "@/lib/tauri/codespace";
import { editorLspResolve, editorLspSend, editorLspStart, editorLspStop, type LspResolution } from "@/lib/tauri/lsp";
import { getEditorFileBuffer, onEditorFileBufferChange, readDiskFile } from "@/modules/codespace/services/editor-file-store";
import { resolveEditorLanguage } from "@/modules/codespace/services/editor-languages";
import { fileUri, LspClient, type LspClientState } from "./lsp-client";
import { LspConnectionClosedError, LspRequestError } from "./lsp-connection";
import {
  markerToDiagnostic,
  toCompletionItem,
  toDocumentSymbols,
  toHover,
  toLocations,
  toLspPosition,
  toLspRange,
  toMarker,
  toMarkdown,
  toMonacoRange,
  toTextEdits,
  type CompletionDefaults,
  type MonacoApi,
} from "./lsp-convert";
import { editorLanguagesForServer, lspLanguageForFile, type LspServerId } from "./lsp-languages";
import type {
  LspCodeAction,
  LspCommand,
  LspCompletionItem,
  LspCompletionList,
  LspDiagnostic,
  LspDocumentHighlight,
  LspDocumentSymbol,
  LspHover,
  LspLocation,
  LspLocationLink,
  LspRange,
  LspSignatureHelp,
  LspSymbolInformation,
  LspTextEdit,
  LspWorkspaceEdit,
} from "./lsp-types";
import { applyLspWorkspaceEdit } from "./lsp-workspace-edit";

export type LspPlace = { location: CodeSpaceStoredWorkspaceLocation | null; rootDir: string };

/** What the status bar says about a file's language server. */
export type LspFileStatus =
  | { kind: "off"; label: string }
  | { kind: "untrusted"; label: string }
  | { kind: "missing"; label: string; installHint: string }
  | { kind: "starting"; label: string }
  | { kind: "ready"; label: string; progress: string | null }
  | { kind: "error"; label: string; message: string };

export type LspNotice = { text: string; severity: "error" | "warning" | "info" };

const SERVER_LABELS: Record<LspServerId, string> = {
  typescript: "TypeScript",
  rust: "rust-analyzer",
  python: "Python",
  go: "gopls",
  clangd: "clangd",
};

function placeKey(location: CodeSpaceStoredWorkspaceLocation | null): string {
  return location?.kind === "ssh"
    ? `ssh:${location.user ?? ""}@${location.host}:${location.port ?? 22}`
    : "local";
}

type ClientEntry = {
  client: LspClient;
  place: LspPlace;
  placeKey: string;
  disposables: IDisposable[];
  stopListening: Array<() => void>;
};

type Attachment = { client: LspClient; entry: ClientEntry; disposables: IDisposable[] };

const CLIENTS = new Map<string, ClientEntry>();
const RESOLVES = new Map<string, Promise<LspResolution>>();
/** Models attached to a server, by file path. */
const ATTACHED = new Map<string, Attachment>();
const FILE_STATUS = new Map<string, LspFileStatus>();
const STATUS_LISTENERS = new Set<() => void>();
const NOTICE_LISTENERS = new Set<(notice: LspNotice) => void>();
let monacoApi: MonacoApi | null = null;
let globalDisposables: IDisposable[] = [];
let stopSaveListener: (() => void) | null = null;

function emitStatus(): void {
  for (const listener of STATUS_LISTENERS) listener();
}

export function onLspStatusChange(listener: () => void): () => void {
  STATUS_LISTENERS.add(listener);
  return () => STATUS_LISTENERS.delete(listener);
}

export function onLspNotice(listener: (notice: LspNotice) => void): () => void {
  NOTICE_LISTENERS.add(listener);
  return () => NOTICE_LISTENERS.delete(listener);
}

function notice(text: string, severity: LspNotice["severity"] = "info"): void {
  for (const listener of NOTICE_LISTENERS) listener({ text, severity });
}

export function getLspFileStatus(path: string | null | undefined): LspFileStatus | null {
  return path ? FILE_STATUS.get(path) ?? null : null;
}

function setFileStatus(path: string, status: LspFileStatus | null): void {
  const current = FILE_STATUS.get(path);
  if (status === null) {
    if (!current) return;
    FILE_STATUS.delete(path);
  } else {
    if (current && JSON.stringify(current) === JSON.stringify(status)) return;
    FILE_STATUS.set(path, status);
  }
  emitStatus();
}

function statusFromClient(label: string, state: LspClientState): LspFileStatus {
  switch (state.kind) {
    case "ready":
      return { kind: "ready", label, progress: state.progress };
    case "error":
      return { kind: "error", label, message: state.message };
    default:
      return { kind: "starting", label };
  }
}

/** Errors and warnings every server of this workspace reports, over all its files. */
export function lspProblemCounts(place: LspPlace): { errors: number; warnings: number } {
  const key = placeKey(place.location);
  const root = place.rootDir.replace(/\/+$/, "");
  let errors = 0;
  let warnings = 0;
  for (const entry of CLIENTS.values()) {
    if (entry.placeKey !== key) continue;
    for (const [path, diagnostics] of entry.client.allDiagnostics()) {
      if (path !== root && !path.startsWith(`${root}/`)) continue;
      for (const diagnostic of diagnostics) {
        const severity = diagnostic.severity ?? 1;
        if (severity === 1) errors += 1;
        else if (severity === 2) warnings += 1;
      }
    }
  }
  return { errors, warnings };
}

function abortOn(token: CancellationToken): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  else token.onCancellationRequested(() => controller.abort());
  return controller.signal;
}

/** A request that failed because the user moved on, or the server went: no answer, quietly. */
function quiet<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return promise.catch((error: unknown) => {
    if (!(error instanceof LspRequestError) && !(error instanceof LspConnectionClosedError)) {
      console.warn("[lsp]", error);
    }
    return fallback;
  });
}

function modelPath(model: editor.ITextModel): string {
  return model.uri.path;
}

function attachmentFor(model: editor.ITextModel, client: LspClient): Attachment | null {
  const attachment = ATTACHED.get(modelPath(model));
  return attachment && attachment.client === client ? attachment : null;
}

function textDocument(model: editor.ITextModel) {
  return { uri: fileUri(modelPath(model)) };
}

// ── Models for other files (peek, ⌘-hover previews) ──────────────────────────

/** Models made only so a peek can show another file; the oldest go first. */
const PEEK_MODELS: string[] = [];
const MAX_PEEK_MODELS = 40;
const MAX_MODELS_PER_ANSWER = 30;

async function ensureModels(monaco: MonacoApi, locations: languages.Location[], place: LspPlace): Promise<void> {
  const missing = [...new Set(locations.map((location) => location.uri.path))]
    .filter((path) => !monaco.editor.getModel(monaco.Uri.file(path)))
    .slice(0, MAX_MODELS_PER_ANSWER);
  await Promise.all(missing.map(async (path) => {
    try {
      const buffer = getEditorFileBuffer(path);
      const content = buffer && !buffer.binary
        ? buffer.content
        : await readDiskFile(path, { location: place.location, rootDir: place.rootDir }).then((disk) => (disk.binary ? null : disk.content));
      if (content === null || monaco.editor.getModel(monaco.Uri.file(path))) return;
      monaco.editor.createModel(content, resolveEditorLanguage(path), monaco.Uri.file(path));
      PEEK_MODELS.push(path);
    } catch {
      // Unreadable: the peek shows that location without its text.
    }
  }));
  while (PEEK_MODELS.length > MAX_PEEK_MODELS) {
    const path = PEEK_MODELS.shift()!;
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    if (model && !model.isAttachedToEditor() && !getEditorFileBuffer(path) && !ATTACHED.has(path)) model.dispose();
  }
}

// ── Opening another file from the editor (go to definition) ─────────────────

type OpenHandler = (path: string, range: { startLine: number; startColumn: number; endLine: number; endColumn: number }) => void;
const OPENERS = new Map<editor.ICodeEditor, OpenHandler>();

/** The pane's way to open a file at a place, for definitions in other files. */
export function setLspEditorOpener(target: editor.ICodeEditor, handler: OpenHandler | null): () => void {
  if (handler) OPENERS.set(target, handler);
  else OPENERS.delete(target);
  return () => {
    if (OPENERS.get(target) === handler) OPENERS.delete(target);
  };
}

function installGlobals(monaco: MonacoApi): void {
  if (monacoApi === monaco) return;
  for (const disposable of globalDisposables) disposable.dispose();
  monacoApi = monaco;
  globalDisposables = [
    monaco.editor.registerEditorOpener({
      openCodeEditor(source, resource, selectionOrPosition) {
        const handler = OPENERS.get(source);
        // The same file: Monaco moves the cursor itself.
        if (!handler || resource.path === source.getModel()?.uri.path) return false;
        const range = selectionOrPosition && "startLineNumber" in selectionOrPosition
          ? { startLine: selectionOrPosition.startLineNumber, startColumn: selectionOrPosition.startColumn, endLine: selectionOrPosition.endLineNumber, endColumn: selectionOrPosition.endColumn }
          : selectionOrPosition
            ? { startLine: selectionOrPosition.lineNumber, startColumn: selectionOrPosition.column, endLine: selectionOrPosition.lineNumber, endColumn: selectionOrPosition.column }
            : { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 };
        handler(resource.path, range);
        return true;
      },
    }),
    monaco.editor.registerCommand(RUN_CODE_ACTION, (_accessor, id: string) => void runCodeAction(id)),
  ];
  stopSaveListener?.();
  // A save is the moment rust-analyzer and others check the whole crate.
  const pendingWrites = new Map<string, string | undefined>();
  stopSaveListener = onEditorFileBufferChange((path, buffer) => {
    const before = pendingWrites.get(path);
    pendingWrites.set(path, buffer?.pendingWrite);
    if (before !== undefined && buffer && buffer.pendingWrite === undefined && buffer.savedContent === before) {
      ATTACHED.get(path)?.client.saveDocument(path);
    }
    if (!buffer) pendingWrites.delete(path);
  });
}

// ── Code actions run through a command, so their edits use our file handling ─

const RUN_CODE_ACTION = "lotus.lsp.runCodeAction";
const CODE_ACTIONS = new Map<string, { entry: ClientEntry; action: LspCodeAction | LspCommand }>();
let codeActionSeq = 0;

function isCommand(action: LspCodeAction | LspCommand): action is LspCommand {
  return typeof (action as LspCommand).command === "string";
}

async function applyEdit(entry: ClientEntry, edit: LspWorkspaceEdit): Promise<boolean> {
  if (!monacoApi) return false;
  const result = await applyLspWorkspaceEdit(monacoApi, edit, { location: entry.place.location, rootDir: entry.place.rootDir });
  for (const failure of result.failed) notice(`Could not change ${failure.path.split("/").pop()}: ${failure.error}`, "error");
  if (result.saved.length > 0) {
    const names = result.saved.map((path) => path.split("/").pop()).slice(0, 3).join(", ");
    const more = result.saved.length > 3 ? ` and ${result.saved.length - 3} more` : "";
    notice(`Changed and saved ${names}${more} (not open in a tab).`);
  }
  return result.failed.length === 0;
}

async function runCodeAction(id: string): Promise<void> {
  const stored = CODE_ACTIONS.get(id);
  if (!stored) return;
  const { entry, action } = stored;
  const client = entry.client;
  try {
    if (isCommand(action)) {
      await client.request("workspace/executeCommand", { command: action.command, arguments: action.arguments });
      return;
    }
    let resolved = action;
    const provider = client.capabilities.codeActionProvider;
    if (!resolved.edit && !resolved.command && typeof provider === "object" && provider.resolveProvider) {
      resolved = await client.request<LspCodeAction>("codeAction/resolve", action);
    }
    if (resolved.edit) await applyEdit(entry, resolved.edit);
    if (resolved.command) {
      await client.request("workspace/executeCommand", { command: resolved.command.command, arguments: resolved.command.arguments });
    }
  } catch (error) {
    notice(`${action.title} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

// ── Editor features, per server ─────────────────────────────────────────────

function registerFeatures(monaco: MonacoApi, entry: ClientEntry, serverId: LspServerId): IDisposable[] {
  const { client } = entry;
  const caps = client.capabilities;
  const languageIds = editorLanguagesForServer(serverId);
  const disposables: IDisposable[] = [];
  const has = (value: unknown) => Boolean(value);
  const owns = (model: editor.ITextModel) => attachmentFor(model, client) !== null;
  const at = (model: editor.ITextModel, position: Position) => ({ textDocument: textDocument(model), position: toLspPosition(position) });

  const locationsFor = (method: string) => async (model: editor.ITextModel, position: Position, token: CancellationToken) => {
    if (!owns(model)) return null;
    const result = await quiet(client.request<LspLocation | LspLocation[] | LspLocationLink[] | null>(method, at(model, position), abortOn(token)), null);
    const locations = toLocations(result, monaco);
    await ensureModels(monaco, locations, entry.place);
    return locations;
  };

  for (const language of languageIds) {
    if (has(caps.hoverProvider)) {
      disposables.push(monaco.languages.registerHoverProvider(language, {
        provideHover: async (model, position, token) => {
          if (!owns(model)) return null;
          return toHover(await quiet(client.request<LspHover | null>("textDocument/hover", at(model, position), abortOn(token)), null));
        },
      }));
    }
    if (has(caps.definitionProvider)) {
      disposables.push(monaco.languages.registerDefinitionProvider(language, { provideDefinition: locationsFor("textDocument/definition") }));
    }
    if (has(caps.typeDefinitionProvider)) {
      disposables.push(monaco.languages.registerTypeDefinitionProvider(language, { provideTypeDefinition: locationsFor("textDocument/typeDefinition") }));
    }
    if (has(caps.implementationProvider)) {
      disposables.push(monaco.languages.registerImplementationProvider(language, { provideImplementation: locationsFor("textDocument/implementation") }));
    }
    if (has(caps.referencesProvider)) {
      disposables.push(monaco.languages.registerReferenceProvider(language, {
        provideReferences: async (model, position, context, token) => {
          if (!owns(model)) return null;
          const result = await quiet(client.request<LspLocation[] | null>(
            "textDocument/references",
            { ...at(model, position), context: { includeDeclaration: context.includeDeclaration } },
            abortOn(token),
          ), null);
          const locations = toLocations(result, monaco);
          await ensureModels(monaco, locations, entry.place);
          return locations;
        },
      }));
    }
    if (has(caps.documentHighlightProvider)) {
      disposables.push(monaco.languages.registerDocumentHighlightProvider(language, {
        provideDocumentHighlights: async (model, position, token) => {
          if (!owns(model)) return null;
          const result = await quiet(client.request<LspDocumentHighlight[] | null>("textDocument/documentHighlight", at(model, position), abortOn(token)), null);
          return (result ?? []).map((item) => ({ range: toMonacoRange(item.range), kind: (item.kind ?? 1) - 1 }));
        },
      }));
    }
    if (has(caps.documentSymbolProvider)) {
      disposables.push(monaco.languages.registerDocumentSymbolProvider(language, {
        displayName: client.label,
        provideDocumentSymbols: async (model, token) => {
          if (!owns(model)) return null;
          const result = await quiet(client.request<LspDocumentSymbol[] | LspSymbolInformation[] | null>(
            "textDocument/documentSymbol",
            { textDocument: textDocument(model) },
            abortOn(token),
          ), null);
          return toDocumentSymbols(result);
        },
      }));
    }
    if (caps.completionProvider) {
      const lspItems = new WeakMap<languages.CompletionItem, LspCompletionItem>();
      const resolveProvider = Boolean(caps.completionProvider.resolveProvider);
      disposables.push(monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: caps.completionProvider.triggerCharacters ?? [],
        provideCompletionItems: async (model, position, context, token) => {
          if (!owns(model)) return null;
          const result = await quiet(client.request<LspCompletionItem[] | LspCompletionList | null>(
            "textDocument/completion",
            {
              ...at(model, position),
              context: {
                triggerKind: context.triggerKind + 1,
                ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}),
              },
            },
            abortOn(token),
          ), null);
          if (!result) return null;
          const word = model.getWordUntilPosition(position);
          const fallback = { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn };
          const list = Array.isArray(result) ? { isIncomplete: false, items: result } : result;
          const defaults: CompletionDefaults = list.itemDefaults ?? {};
          const suggestions = list.items.map((item) => {
            const lspItem = list.itemDefaults?.data !== undefined && item.data === undefined ? { ...item, data: list.itemDefaults.data } : item;
            const suggestion = toCompletionItem(lspItem, fallback, defaults);
            lspItems.set(suggestion, lspItem);
            return suggestion;
          });
          return { suggestions, incomplete: list.isIncomplete };
        },
        resolveCompletionItem: resolveProvider
          ? async (item, token) => {
            const lspItem = lspItems.get(item);
            if (!lspItem) return item;
            const resolved = await quiet(client.request<LspCompletionItem | null>("completionItem/resolve", lspItem, abortOn(token)), null);
            if (!resolved) return item;
            return {
              ...item,
              detail: resolved.detail ?? item.detail,
              documentation: toMarkdown(resolved.documentation) ?? item.documentation,
              additionalTextEdits: resolved.additionalTextEdits ? toTextEdits(resolved.additionalTextEdits) : item.additionalTextEdits,
            };
          }
          : undefined,
      }));
    }
    if (caps.signatureHelpProvider) {
      disposables.push(monaco.languages.registerSignatureHelpProvider(language, {
        signatureHelpTriggerCharacters: caps.signatureHelpProvider.triggerCharacters ?? [],
        signatureHelpRetriggerCharacters: caps.signatureHelpProvider.retriggerCharacters ?? [],
        provideSignatureHelp: async (model, position, token, context) => {
          if (!owns(model)) return null;
          const result = await quiet(client.request<LspSignatureHelp | null>(
            "textDocument/signatureHelp",
            {
              ...at(model, position),
              context: {
                triggerKind: context.triggerKind,
                ...(context.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}),
                isRetrigger: context.isRetrigger,
              },
            },
            abortOn(token),
          ), null);
          if (!result || result.signatures.length === 0) return null;
          return {
            value: {
              signatures: result.signatures.map((signature) => ({
                label: signature.label,
                documentation: toMarkdown(signature.documentation),
                parameters: (signature.parameters ?? []).map((parameter) => ({
                  label: parameter.label,
                  documentation: toMarkdown(parameter.documentation),
                })),
                activeParameter: signature.activeParameter,
              })),
              activeSignature: result.activeSignature ?? 0,
              activeParameter: result.activeParameter ?? 0,
            },
            dispose() {},
          };
        },
      }));
    }
    if (caps.renameProvider) {
      const prepare = typeof caps.renameProvider === "object" && caps.renameProvider.prepareProvider;
      disposables.push(monaco.languages.registerRenameProvider(language, {
        provideRenameEdits: async (model, position, newName) => {
          if (!owns(model)) return null;
          try {
            const edit = await client.request<LspWorkspaceEdit | null>("textDocument/rename", { ...at(model, position), newName });
            if (edit) await applyEdit(entry, edit);
          } catch (error) {
            return { edits: [], rejectReason: error instanceof Error ? error.message : String(error) };
          }
          // Applied above: Monaco can only edit files that have a model, and it would not save.
          return { edits: [] };
        },
        resolveRenameLocation: prepare
          ? async (model, position, token) => {
            if (!owns(model)) return null;
            const result = await quiet(client.request<LspRange | { range: LspRange; placeholder: string } | { defaultBehavior: boolean } | null>(
              "textDocument/prepareRename",
              at(model, position),
              abortOn(token),
            ), null);
            if (!result) return { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: "", rejectReason: "This cannot be renamed." };
            if ("defaultBehavior" in result) {
              const word = model.getWordAtPosition(position);
              if (!word) return { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: "", rejectReason: "This cannot be renamed." };
              return { range: { startLineNumber: position.lineNumber, startColumn: word.startColumn, endLineNumber: position.lineNumber, endColumn: word.endColumn }, text: word.word };
            }
            const range = "start" in result ? result : result.range;
            const monacoRange = toMonacoRange(range);
            return { range: monacoRange, text: "placeholder" in result ? result.placeholder : model.getValueInRange(monacoRange) };
          }
          : undefined,
      }));
    }
    if (caps.codeActionProvider) {
      disposables.push(monaco.languages.registerCodeActionProvider(language, {
        provideCodeActions: async (model, range, context, token) => {
          if (!owns(model)) return null;
          const result = await quiet(client.request<Array<LspCodeAction | LspCommand> | null>(
            "textDocument/codeAction",
            {
              textDocument: textDocument(model),
              range: toLspRange(range),
              context: {
                diagnostics: context.markers.map(markerToDiagnostic),
                ...(context.only ? { only: [context.only] } : {}),
                triggerKind: context.trigger === 1 ? 1 : 2,
              },
            },
            abortOn(token),
          ), null);
          if (!result) return null;
          if (CODE_ACTIONS.size > 500) CODE_ACTIONS.clear();
          const actions: languages.CodeAction[] = result.map((action) => {
            codeActionSeq += 1;
            const id = String(codeActionSeq);
            CODE_ACTIONS.set(id, { entry, action });
            const literal = isCommand(action) ? null : action;
            return {
              title: action.title,
              kind: literal?.kind,
              isPreferred: literal?.isPreferred,
              disabled: literal?.disabled?.reason,
              diagnostics: literal?.diagnostics?.map((diagnostic) => toMarker(diagnostic, monaco)),
              command: { id: RUN_CODE_ACTION, title: action.title, arguments: [id] },
            };
          });
          return { actions, dispose() {} };
        },
      }, {
        providedCodeActionKinds: typeof caps.codeActionProvider === "object" ? caps.codeActionProvider.codeActionKinds : undefined,
      }));
    }
    if (has(caps.documentFormattingProvider)) {
      disposables.push(monaco.languages.registerDocumentFormattingEditProvider(language, {
        displayName: client.label,
        provideDocumentFormattingEdits: async (model, options, token) => {
          if (!owns(model)) return null;
          return toTextEdits(await quiet(client.request<LspTextEdit[] | null>(
            "textDocument/formatting",
            { textDocument: textDocument(model), options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } },
            abortOn(token),
          ), null));
        },
      }));
    }
    if (has(caps.documentRangeFormattingProvider)) {
      disposables.push(monaco.languages.registerDocumentRangeFormattingEditProvider(language, {
        displayName: client.label,
        provideDocumentRangeFormattingEdits: async (model, range, options, token) => {
          if (!owns(model)) return null;
          return toTextEdits(await quiet(client.request<LspTextEdit[] | null>(
            "textDocument/rangeFormatting",
            { textDocument: textDocument(model), range: toLspRange(range), options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } },
            abortOn(token),
          ), null));
        },
      }));
    }
  }
  return disposables;
}

/**
 * Monaco's own TypeScript worker answers hovers and completions for `.ts`/`.js` without the
 * project's types. With the real server running it would answer everything twice.
 */
function quietBuiltInTypeScript(monaco: MonacoApi): void {
  type Defaults = { setModeConfiguration?: (config: Record<string, boolean>) => void };
  const typescript = (monaco.languages as unknown as { typescript?: { typescriptDefaults?: Defaults; javascriptDefaults?: Defaults } }).typescript;
  const off = {
    completionItems: false,
    hovers: false,
    documentSymbols: false,
    definitions: false,
    references: false,
    documentHighlights: false,
    rename: false,
    diagnostics: false,
    documentRangeFormattingEdits: false,
    signatureHelp: false,
    onTypeFormattingEdits: false,
    codeActions: false,
    inlayHints: false,
  };
  typescript?.typescriptDefaults?.setModeConfiguration?.(off);
  typescript?.javascriptDefaults?.setModeConfiguration?.(off);
}

// ── Servers ─────────────────────────────────────────────────────────────────

function resolveFor(place: LspPlace, serverId: LspServerId, path: string): Promise<LspResolution> {
  const folder = path.slice(0, path.lastIndexOf("/"));
  const key = `${placeKey(place.location)}|${serverId}|${folder}`;
  let pending = RESOLVES.get(key);
  if (!pending) {
    pending = editorLspResolve(place.location, serverId, path, place.rootDir);
    RESOLVES.set(key, pending);
    // A failed probe (host offline) is asked again next time.
    pending.catch(() => RESOLVES.delete(key));
  }
  return pending;
}

function clientFor(monaco: MonacoApi, place: LspPlace, serverId: LspServerId, resolution: LspResolution): ClientEntry {
  const key = `${placeKey(place.location)}|${serverId}|${resolution.projectRoot}`;
  const existing = CLIENTS.get(key);
  if (existing) return existing;
  const command = resolution.command!;
  const label = SERVER_LABELS[serverId];
  const entry = {} as ClientEntry;
  const client = new LspClient({
    serverId,
    label,
    projectRoot: resolution.projectRoot,
    transport: {
      start: (onEvent) => editorLspStart(place.location, command, resolution.projectRoot, onEvent),
      send: (sessionId, message) => editorLspSend(sessionId, message),
      stop: (sessionId) => editorLspStop(sessionId),
    },
    applyEdit: (edit) => applyEdit(entry, edit),
    onMessage: (text, severity) => {
      if (severity !== "info") notice(`${label}: ${text}`, severity);
    },
  });
  Object.assign(entry, { client, place, placeKey: placeKey(place.location), disposables: [], stopListening: [] });
  let registered = false;
  entry.stopListening.push(client.onStateChange((state) => {
    if (state.kind === "ready" && !registered) {
      registered = true;
      entry.disposables = registerFeatures(monaco, entry, serverId);
      if (serverId === "typescript") quietBuiltInTypeScript(monaco);
    }
    for (const [path, attachment] of ATTACHED) {
      if (attachment.client === client) setFileStatus(path, statusFromClient(label, state));
    }
  }));
  entry.stopListening.push(client.onDiagnostics((path, diagnostics) => {
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    if (model) monaco.editor.setModelMarkers(model, `lsp-${serverId}`, diagnostics.map((diagnostic) => toMarker(diagnostic, monaco)));
    emitStatus();
  }));
  CLIENTS.set(key, entry);
  return entry;
}

export type AttachLspOptions = {
  /** Settings: language servers on. */
  enabled: boolean;
  /** The workspace folder is trusted to run its tools. */
  trusted: boolean;
};

/**
 * Connects a model the editor shows to its language server, starting the server when needed.
 * Safe to call again for the same model; the attachment lasts until the model is disposed.
 */
export async function attachLspModel(
  monaco: MonacoApi,
  model: editor.ITextModel,
  place: LspPlace,
  options: AttachLspOptions,
): Promise<void> {
  const path = modelPath(model);
  const language = lspLanguageForFile(path);
  if (!language) {
    setFileStatus(path, null);
    return;
  }
  const label = SERVER_LABELS[language.serverId];
  if (!options.enabled || !options.trusted) {
    // Turned off, or trust taken back: the file leaves its server.
    detach(path);
    setFileStatus(path, options.enabled ? { kind: "untrusted", label } : { kind: "off", label });
    return;
  }
  const existing = ATTACHED.get(path);
  if (existing) {
    setFileStatus(path, statusFromClient(label, existing.client.getState()));
    return;
  }
  installGlobals(monaco);
  setFileStatus(path, FILE_STATUS.get(path)?.kind === "ready" ? FILE_STATUS.get(path)! : { kind: "starting", label });
  let resolution: LspResolution;
  try {
    resolution = await resolveFor(place, language.serverId, path);
  } catch (error) {
    setFileStatus(path, { kind: "error", label, message: `Could not look for ${label}: ${error instanceof Error ? error.message : String(error)}` });
    return;
  }
  if (model.isDisposed() || ATTACHED.has(path)) return;
  if (!resolution.command) {
    setFileStatus(path, { kind: "missing", label, installHint: resolution.installHint });
    return;
  }
  const entry = clientFor(monaco, place, language.serverId, resolution);
  const { client } = entry;
  const owner = `lsp-${language.serverId}`;
  const attachment: Attachment = { client, entry, disposables: [] };
  ATTACHED.set(path, attachment);
  attachment.disposables.push(
    model.onDidChangeContent((event) => {
      client.changeDocument(
        path,
        model.getVersionId(),
        event.changes.map((change) => ({ range: toLspRange(change.range), text: change.text })),
        () => model.getValue(),
      );
    }),
    model.onWillDispose(() => detach(path)),
  );
  client.openDocument(path, language.languageId, model.getVersionId(), () => model.getValue());
  const diagnostics: LspDiagnostic[] = client.getDiagnostics(path);
  monaco.editor.setModelMarkers(model, owner, diagnostics.map((diagnostic) => toMarker(diagnostic, monaco)));
  setFileStatus(path, statusFromClient(label, client.getState()));
}

function detach(path: string): void {
  const attachment = ATTACHED.get(path);
  if (!attachment) return;
  ATTACHED.delete(path);
  for (const disposable of attachment.disposables) disposable.dispose();
  attachment.client.closeDocument(path);
  setFileStatus(path, null);
}

/** Files changed on disk (the pane's watcher), for servers that track the disk. */
export function notifyLspFilesChanged(location: CodeSpaceStoredWorkspaceLocation | null, paths: string[]): void {
  const key = placeKey(location);
  for (const entry of CLIENTS.values()) {
    if (entry.placeKey === key) entry.client.notifyFilesChanged(paths);
  }
}

/** Restarts the server of this file (a palette command), keeping its open files. */
export async function restartLspForFile(path: string): Promise<boolean> {
  const attachment = ATTACHED.get(path);
  if (!attachment) return false;
  await attachment.client.restart().catch(() => {});
  return true;
}

/** Every server stops (the setting was turned off). Open files keep no markers. */
export async function stopAllLsp(): Promise<void> {
  const entries = [...CLIENTS.values()];
  CLIENTS.clear();
  RESOLVES.clear();
  for (const path of [...ATTACHED.keys()]) detach(path);
  await Promise.all(entries.map(async (entry) => {
    for (const disposable of entry.disposables) disposable.dispose();
    for (const stop of entry.stopListening) stop();
    if (monacoApi) {
      for (const path of entry.client.allDiagnostics().keys()) {
        const model = monacoApi.editor.getModel(monacoApi.Uri.file(path));
        if (model) monacoApi.editor.setModelMarkers(model, `lsp-${entry.client.serverId}`, []);
      }
    }
    await entry.client.stop();
  }));
  emitStatus();
}

/** For tests: forget everything without stopping anything. */
export function resetLspForTest(): void {
  CLIENTS.clear();
  RESOLVES.clear();
  ATTACHED.clear();
  FILE_STATUS.clear();
  CODE_ACTIONS.clear();
  PEEK_MODELS.length = 0;
  OPENERS.clear();
  for (const disposable of globalDisposables) disposable.dispose();
  globalDisposables = [];
  monacoApi = null;
  stopSaveListener?.();
  stopSaveListener = null;
}

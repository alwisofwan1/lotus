/*
 * One running language server: its life (start, crash, restart, idle stop), the files it has
 * open, and what it reports (diagnostics, progress). Knows nothing of Monaco; `lsp-monaco.ts`
 * feeds it the editor's text and turns its answers into editor features.
 */

import { LspConnection, LspConnectionClosedError } from "./lsp-connection";
import type { LspDiagnostic, LspServerCapabilities, LspTextDocumentSyncKind, LspWorkspaceEdit } from "./lsp-types";
import type { LspEvent } from "@/lib/tauri/lsp";

export function fileUri(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The path a `file:` URI names, decoded; `null` for any other scheme. */
export function uriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  const rest = uri.slice("file://".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  try {
    return decodeURIComponent(rest.slice(slash));
  } catch {
    return rest.slice(slash);
  }
}

export type LspClientState =
  | { kind: "starting" }
  | { kind: "ready"; progress: string | null }
  | { kind: "error"; message: string }
  | { kind: "stopped" };

/** What a client needs from the place it runs: start the process, send to it, stop it. */
export type LspTransport = {
  start(onEvent: (event: LspEvent) => void): Promise<string>;
  send(sessionId: string, message: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
};

export type LspClientOptions = {
  serverId: string;
  label: string;
  projectRoot: string;
  transport: LspTransport;
  /** The server asks for an edit (a code action's command, a refactor). */
  applyEdit: (edit: LspWorkspaceEdit) => Promise<boolean>;
  /** A message the user should see (`window/showMessage`, errors). */
  onMessage?: (text: string, severity: "error" | "warning" | "info") => void;
  /** Crashes inside `CRASH_WINDOW_MS` before it stays down. */
  maxRestarts?: number;
  /** With no open file for this long, the server is stopped (it holds a lot of memory). */
  idleStopMs?: number;
};

type OpenDocument = { languageId: string; version: number; text: () => string };

const CRASH_WINDOW_MS = 3 * 60_000;

/** The last lines the server wrote to stderr say why it stopped, better than its exit code. */
function describeExit(code: number | null, stderr: string): string {
  const tail = stderr.trim().split("\n").slice(-3).join("\n").trim();
  return tail || (code === null ? "it was stopped" : `exit code ${code}`);
}
const SHUTDOWN_GRACE_MS = 1500;

export class LspClient {
  readonly serverId: string;
  readonly label: string;
  readonly projectRoot: string;
  private state: LspClientState = { kind: "stopped" };
  private connection: LspConnection | null = null;
  private sessionId: string | null = null;
  private starting: Promise<void> | null = null;
  private stopping = false;
  private crashes: number[] = [];
  private lastExit: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly documents = new Map<string, OpenDocument>();
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private readonly progress = new Map<string | number, string>();
  private readonly stateListeners = new Set<(state: LspClientState) => void>();
  private readonly diagnosticListeners = new Set<(path: string, diagnostics: LspDiagnostic[]) => void>();
  capabilities: LspServerCapabilities = {};

  constructor(private readonly options: LspClientOptions) {
    this.serverId = options.serverId;
    this.label = options.label;
    this.projectRoot = options.projectRoot;
  }

  getState(): LspClientState {
    return this.state;
  }

  onStateChange(listener: (state: LspClientState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onDiagnostics(listener: (path: string, diagnostics: LspDiagnostic[]) => void): () => void {
    this.diagnosticListeners.add(listener);
    return () => this.diagnosticListeners.delete(listener);
  }

  getDiagnostics(path: string): LspDiagnostic[] {
    return this.diagnostics.get(path) ?? [];
  }

  /** Every file's diagnostics the server has reported and not cleared. */
  allDiagnostics(): ReadonlyMap<string, LspDiagnostic[]> {
    return this.diagnostics;
  }

  /** Whether this server serves a file at `path` (it is under the project root). */
  covers(path: string): boolean {
    const root = this.projectRoot.replace(/\/+$/, "");
    return root === "" || path === root || path.startsWith(`${root}/`);
  }

  isOpen(path: string): boolean {
    return this.documents.has(path);
  }

  private setState(state: LspClientState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }

  start(): Promise<void> {
    if (this.state.kind === "ready") return Promise.resolve();
    if (this.starting) return this.starting;
    this.stopping = false;
    this.starting = this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<void> {
    this.setState({ kind: "starting" });
    this.progress.clear();
    let connection: LspConnection | null = null;
    let sessionId: string | null = null;
    const pending: string[] = [];
    let earlyExit: string | null = null;
    this.lastExit = null;
    try {
      sessionId = await this.options.transport.start((event) => {
        if (event.kind === "message") {
          if (connection) connection.receive(event.data);
          else pending.push(event.data);
        } else if (!connection) {
          earlyExit = describeExit(event.code, event.stderr);
        } else {
          this.handleExit(connection, event.code, event.stderr);
        }
      });
      if (earlyExit) throw new Error(earlyExit);
      const id = sessionId;
      connection = new LspConnection({ send: (message) => this.options.transport.send(id, message) });
      this.connection = connection;
      this.sessionId = sessionId;
      this.installHandlers(connection);
      for (const data of pending.splice(0)) connection.receive(data);
      const result = await connection.request<{ capabilities?: LspServerCapabilities }>("initialize", this.initializeParams());
      this.capabilities = result?.capabilities ?? {};
      connection.notify("initialized", {});
      if (this.stopping || connection.isClosed) return;
      // Files opened while it started (or before a restart) are opened now.
      for (const [path, document] of this.documents) this.sendOpen(path, document);
      this.setState({ kind: "ready", progress: null });
      this.scheduleIdleStop();
    } catch (error) {
      if (this.connection === connection) {
        connection?.close();
        this.connection = null;
      }
      if (sessionId) void this.options.transport.stop(sessionId).catch(() => {});
      this.sessionId = null;
      if (this.state.kind !== "error") {
        const message = error instanceof LspConnectionClosedError
          ? `${this.label} stopped while starting: ${this.lastExit ?? "no reason given"}`
          : `${this.label} could not start: ${error instanceof Error ? error.message : String(error)}`;
        this.setState({ kind: "error", message });
      }
      throw error;
    }
  }

  private initializeParams() {
    const rootUri = fileUri(this.projectRoot);
    const name = this.projectRoot.split("/").filter(Boolean).pop() ?? this.projectRoot;
    const documentationFormat = ["markdown", "plaintext"];
    return {
      processId: null,
      clientInfo: { name: "Lotus" },
      rootUri,
      rootPath: this.projectRoot,
      workspaceFolders: [{ uri: rootUri, name }],
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        window: { workDoneProgress: true, showMessage: {} },
        workspace: {
          applyEdit: true,
          workspaceEdit: { documentChanges: true },
          configuration: true,
          workspaceFolders: true,
          didChangeWatchedFiles: { dynamicRegistration: true },
          executeCommand: {},
        },
        textDocument: {
          synchronization: { didSave: true, willSave: false, dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] }, codeDescriptionSupport: true },
          completion: {
            contextSupport: true,
            completionItem: {
              snippetSupport: true,
              documentationFormat,
              deprecatedSupport: true,
              preselectSupport: true,
              insertReplaceSupport: true,
              labelDetailsSupport: true,
              tagSupport: { valueSet: [1] },
              resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] },
            },
            completionList: { itemDefaults: ["editRange", "insertTextFormat", "data"] },
          },
          hover: { contentFormat: documentationFormat },
          signatureHelp: {
            signatureInformation: { documentationFormat, parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true },
          },
          definition: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          implementation: { linkSupport: true },
          references: {},
          documentHighlight: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          codeAction: {
            isPreferredSupport: true,
            disabledSupport: true,
            dataSupport: true,
            resolveSupport: { properties: ["edit"] },
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"],
              },
            },
          },
          formatting: {},
          rangeFormatting: {},
          rename: { prepareSupport: true },
        },
      },
    };
  }

  private installHandlers(connection: LspConnection): void {
    connection.onRequest("workspace/configuration", (params) => {
      const items = (params as { items?: unknown[] } | null)?.items ?? [];
      return items.map(() => null);
    });
    connection.onRequest("workspace/workspaceFolders", () => [{ uri: fileUri(this.projectRoot), name: this.label }]);
    connection.onRequest("client/registerCapability", () => null);
    connection.onRequest("client/unregisterCapability", () => null);
    connection.onRequest("window/workDoneProgress/create", () => null);
    connection.onRequest("window/showMessageRequest", () => null);
    connection.onRequest("window/showDocument", () => ({ success: false }));
    for (const method of ["workspace/semanticTokens/refresh", "workspace/inlayHint/refresh", "workspace/codeLens/refresh", "workspace/diagnostic/refresh", "workspace/inlineValue/refresh"]) {
      connection.onRequest(method, () => null);
    }
    connection.onRequest("workspace/applyEdit", async (params) => {
      const edit = (params as { edit?: LspWorkspaceEdit } | null)?.edit;
      if (!edit) return { applied: false };
      try {
        return { applied: await this.options.applyEdit(edit) };
      } catch (error) {
        return { applied: false, failureReason: error instanceof Error ? error.message : String(error) };
      }
    });
    connection.onNotification("textDocument/publishDiagnostics", (params) => {
      const { uri, diagnostics } = (params ?? {}) as { uri?: string; diagnostics?: LspDiagnostic[] };
      const path = uri ? uriToPath(uri) : null;
      if (!path) return;
      if (diagnostics && diagnostics.length > 0) this.diagnostics.set(path, diagnostics);
      else this.diagnostics.delete(path);
      for (const listener of this.diagnosticListeners) listener(path, diagnostics ?? []);
    });
    connection.onNotification("$/progress", (params) => {
      const { token, value } = (params ?? {}) as { token?: string | number; value?: { kind?: string; title?: string; message?: string; percentage?: number } };
      if (token === undefined || !value) return;
      if (value.kind === "end") this.progress.delete(token);
      else {
        const title = value.kind === "begin" ? value.title ?? "" : this.progress.get(token) ?? "";
        const percent = typeof value.percentage === "number" ? ` ${Math.round(value.percentage)}%` : "";
        this.progress.set(token, value.kind === "begin" ? title : title.replace(/ \d+%$/, "") + percent);
      }
      if (this.state.kind === "ready") {
        const shown = [...this.progress.values()].pop() ?? null;
        if (shown !== this.state.progress) this.setState({ kind: "ready", progress: shown });
      }
    });
    connection.onNotification("window/showMessage", (params) => {
      const { type, message } = (params ?? {}) as { type?: number; message?: string };
      if (!message) return;
      this.options.onMessage?.(message, type === 1 ? "error" : type === 2 ? "warning" : "info");
    });
  }

  private handleExit(connection: LspConnection | null, code: number | null, stderr: string): void {
    if (connection && this.connection !== connection) return;
    connection?.close();
    this.connection = null;
    this.sessionId = null;
    this.progress.clear();
    this.clearAllDiagnostics();
    if (this.stopping) {
      this.setState({ kind: "stopped" });
      return;
    }
    const now = Date.now();
    this.crashes = [...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
    const why = describeExit(code, stderr);
    this.lastExit = why;
    if (this.crashes.length > (this.options.maxRestarts ?? 3)) {
      this.setState({ kind: "error", message: `${this.label} stopped: ${why}` });
      return;
    }
    this.setState({ kind: "starting" });
    setTimeout(() => {
      if (!this.stopping && this.state.kind === "starting" && !this.starting) void this.start().catch(() => {});
    }, 1000);
  }

  private clearAllDiagnostics(): void {
    const paths = [...this.diagnostics.keys()];
    this.diagnostics.clear();
    for (const path of paths) for (const listener of this.diagnosticListeners) listener(path, []);
  }

  private syncKind(): LspTextDocumentSyncKind {
    const sync = this.capabilities.textDocumentSync;
    if (typeof sync === "number") return sync;
    return sync?.change ?? 0;
  }

  private sendOpen(path: string, document: OpenDocument): void {
    this.connection?.notify("textDocument/didOpen", {
      textDocument: { uri: fileUri(path), languageId: document.languageId, version: document.version, text: document.text() },
    });
  }

  /** `text` is read when the open is sent: a server still starting gets the text it has then. */
  openDocument(path: string, languageId: string, version: number, text: () => string): void {
    if (this.documents.has(path)) return;
    const document = { languageId, version, text };
    this.documents.set(path, document);
    this.cancelIdleStop();
    if (this.state.kind === "ready") this.sendOpen(path, document);
    else if (this.state.kind === "stopped") void this.start().catch(() => {});
  }

  /**
   * The file changed: `changes` are the editor's edits, in the order they apply, with `fullText`
   * for a server that wants the whole text each time.
   */
  changeDocument(path: string, version: number, changes: Array<{ range: import("./lsp-types").LspRange; text: string }>, fullText: () => string): void {
    const document = this.documents.get(path);
    if (!document) return;
    document.version = version;
    if (this.state.kind !== "ready") return;
    const kind = this.syncKind();
    if (kind === 0) return;
    const contentChanges = kind === 1 ? [{ text: fullText() }] : changes;
    this.connection?.notify("textDocument/didChange", { textDocument: { uri: fileUri(path), version }, contentChanges });
  }

  saveDocument(path: string): void {
    const document = this.documents.get(path);
    if (!document || this.state.kind !== "ready") return;
    const sync = this.capabilities.textDocumentSync;
    const save = typeof sync === "object" ? sync.save : undefined;
    const includeText = typeof save === "object" && save.includeText;
    this.connection?.notify("textDocument/didSave", {
      textDocument: { uri: fileUri(path) },
      ...(includeText ? { text: document.text() } : {}),
    });
  }

  closeDocument(path: string): void {
    if (!this.documents.delete(path)) return;
    if (this.state.kind === "ready") this.connection?.notify("textDocument/didClose", { textDocument: { uri: fileUri(path) } });
    this.scheduleIdleStop();
  }

  /** Files changed on disk (the watcher): servers that track the disk re-read them. */
  notifyFilesChanged(paths: string[]): void {
    if (this.state.kind !== "ready") return;
    const changes = paths.filter((path) => this.covers(path)).map((path) => ({ uri: fileUri(path), type: 2 }));
    if (changes.length > 0) this.connection?.notify("workspace/didChangeWatchedFiles", { changes });
  }

  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (this.state.kind !== "ready" || !this.connection) return Promise.reject(new LspConnectionClosedError());
    return this.connection.request<T>(method, params, signal);
  }

  private scheduleIdleStop(): void {
    this.cancelIdleStop();
    const after = this.options.idleStopMs ?? 3 * 60_000;
    if (this.documents.size > 0 || after <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.documents.size === 0) void this.stop();
    }, after);
  }

  private cancelIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Asks the server to shut down, then ends the process. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.cancelIdleStop();
    const connection = this.connection;
    const sessionId = this.sessionId;
    if (connection && !connection.isClosed && this.state.kind === "ready") {
      await Promise.race([
        connection.request("shutdown").catch(() => null),
        new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS)),
      ]);
      connection.notify("exit");
    }
    connection?.close();
    this.connection = null;
    this.sessionId = null;
    if (sessionId) await this.options.transport.stop(sessionId).catch(() => {});
    this.clearAllDiagnostics();
    this.setState({ kind: "stopped" });
  }

  /** Stop and start again, keeping the open files (the "Restart language server" command). */
  async restart(): Promise<void> {
    await this.stop();
    this.crashes = [];
    await this.start();
  }
}

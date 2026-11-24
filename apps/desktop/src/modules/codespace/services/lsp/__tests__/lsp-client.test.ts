import { afterEach, describe, expect, it, vi } from "vitest";
import { LspClient, fileUri, uriToPath, type LspTransport } from "../lsp-client";
import type { LspEvent } from "@/lib/tauri/lsp";

type Server = {
  transport: LspTransport;
  sent: Array<Record<string, unknown>>;
  emit: (event: LspEvent) => void;
  reply: (result: unknown) => void;
  starts: number;
};

/** A fake server: answers `initialize` with the given capabilities unless told not to. */
function fakeServer(capabilities: Record<string, unknown> = { textDocumentSync: 2 }, autoInit = true): Server {
  const server: Server = {
    sent: [],
    starts: 0,
    emit: () => {},
    reply: () => {},
    transport: {
      start: async (onEvent) => {
        server.starts += 1;
        server.emit = onEvent;
        return `s${server.starts}`;
      },
      send: async (_id, message) => {
        const parsed = JSON.parse(message) as Record<string, unknown>;
        server.sent.push(parsed);
        server.reply = (result) => server.emit({ kind: "message", data: JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }) });
        if (autoInit && parsed.method === "initialize") server.reply({ capabilities });
        if (parsed.method === "shutdown") server.reply(null);
      },
      stop: vi.fn(async () => {}),
    },
  };
  return server;
}

function client(server: Server, options: Partial<ConstructorParameters<typeof LspClient>[0]> = {}) {
  return new LspClient({
    serverId: "typescript",
    label: "TypeScript",
    projectRoot: "/repo",
    transport: server.transport,
    applyEdit: async () => true,
    idleStopMs: 0,
    ...options,
  });
}

const methods = (server: Server) => server.sent.map((message) => message.method);

afterEach(() => {
  vi.useRealTimers();
});

describe("uris", () => {
  it("round-trips paths with spaces", () => {
    expect(fileUri("/a b/c#.ts")).toBe("file:///a%20b/c%23.ts");
    expect(uriToPath("file:///a%20b/c%23.ts")).toBe("/a b/c#.ts");
    expect(uriToPath("untitled:Untitled-1")).toBeNull();
  });
});

describe("LspClient", () => {
  it("initializes, then opens the files opened while it started", async () => {
    const server = fakeServer();
    const lsp = client(server);
    lsp.openDocument("/repo/a.ts", "typescript", 1, () => "let a");
    await vi.waitFor(() => expect(lsp.getState().kind).toBe("ready"));
    expect(methods(server)).toEqual(["initialize", "initialized", "textDocument/didOpen"]);
    expect(server.sent[0].params).toMatchObject({ rootUri: "file:///repo" });
    expect(server.sent[2].params).toMatchObject({ textDocument: { uri: "file:///repo/a.ts", version: 1, text: "let a" } });
  });

  it("sends incremental changes, or the whole text for a full-sync server", async () => {
    const incremental = fakeServer({ textDocumentSync: 2 });
    const a = client(incremental);
    a.openDocument("/repo/a.ts", "typescript", 1, () => "ab");
    await vi.waitFor(() => expect(a.getState().kind).toBe("ready"));
    a.changeDocument("/repo/a.ts", 2, [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } }, text: "x" }], () => "axb");
    expect(incremental.sent.at(-1)).toMatchObject({ method: "textDocument/didChange", params: { textDocument: { version: 2 }, contentChanges: [{ text: "x" }] } });

    const full = fakeServer({ textDocumentSync: { change: 1 } });
    const b = client(full);
    b.openDocument("/repo/a.ts", "typescript", 1, () => "ab");
    await vi.waitFor(() => expect(b.getState().kind).toBe("ready"));
    b.changeDocument("/repo/a.ts", 2, [], () => "axb");
    expect(full.sent.at(-1)).toMatchObject({ params: { contentChanges: [{ text: "axb" }] } });
  });

  it("keeps diagnostics until the server clears them", async () => {
    const server = fakeServer();
    const lsp = client(server);
    const seen = vi.fn();
    lsp.onDiagnostics(seen);
    lsp.openDocument("/repo/a.ts", "typescript", 1, () => "");
    await vi.waitFor(() => expect(lsp.getState().kind).toBe("ready"));
    const diagnostic = { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "bad" };
    server.emit({ kind: "message", data: JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///repo/a.ts", diagnostics: [diagnostic] } }) });
    expect(lsp.getDiagnostics("/repo/a.ts")).toEqual([diagnostic]);
    expect(seen).toHaveBeenCalledWith("/repo/a.ts", [diagnostic]);
    server.emit({ kind: "message", data: JSON.stringify({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: "file:///repo/a.ts", diagnostics: [] } }) });
    expect(lsp.allDiagnostics().size).toBe(0);
  });

  it("restarts after a crash, then gives up with the stderr tail", async () => {
    vi.useFakeTimers();
    const server = fakeServer();
    const lsp = client(server, { maxRestarts: 1 });
    lsp.openDocument("/repo/a.ts", "typescript", 1, () => "");
    await vi.waitFor(() => expect(lsp.getState().kind).toBe("ready"));
    server.emit({ kind: "exit", code: 1, stderr: "panic: one" });
    expect(lsp.getState().kind).toBe("starting");
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(lsp.getState().kind).toBe("ready"));
    expect(server.starts).toBe(2);
    // The open file is opened again in the new server.
    expect(methods(server).filter((method) => method === "textDocument/didOpen")).toHaveLength(2);
    server.emit({ kind: "exit", code: 1, stderr: "line\npanic: two" });
    expect(lsp.getState()).toEqual({ kind: "error", message: "TypeScript stopped: line\npanic: two" });
  });

  it("reports a server that exits before it starts", async () => {
    const server = fakeServer();
    server.transport.start = async (onEvent) => {
      onEvent({ kind: "exit", code: 127, stderr: "node: not found" });
      return "s1";
    };
    const lsp = client(server);
    await expect(lsp.start()).rejects.toThrow("node: not found");
    expect(lsp.getState()).toEqual({ kind: "error", message: "TypeScript could not start: node: not found" });
  });

  it("stops when no file is open for the idle time, and shuts down politely", async () => {
    vi.useFakeTimers();
    const server = fakeServer();
    const lsp = client(server, { idleStopMs: 1000 });
    lsp.openDocument("/repo/a.ts", "typescript", 1, () => "");
    await vi.waitFor(() => expect(lsp.getState().kind).toBe("ready"));
    lsp.closeDocument("/repo/a.ts");
    await vi.advanceTimersByTimeAsync(999);
    expect(lsp.getState().kind).toBe("ready");
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(lsp.getState().kind).toBe("stopped"));
    expect(methods(server).slice(-3)).toEqual(["textDocument/didClose", "shutdown", "exit"]);
    expect(server.transport.stop).toHaveBeenCalledWith("s1");
  });

  it("applies a server's edit request through the option", async () => {
    const server = fakeServer();
    const applyEdit = vi.fn(async () => true);
    const lsp = client(server, { applyEdit });
    lsp.openDocument("/repo/a.ts", "typescript", 1, () => "");
    await vi.waitFor(() => expect(lsp.getState().kind).toBe("ready"));
    server.emit({ kind: "message", data: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "workspace/applyEdit", params: { edit: { changes: {} } } }) });
    await vi.waitFor(() => expect(server.sent.at(-1)).toEqual({ jsonrpc: "2.0", id: 99, result: { applied: true } }));
    expect(applyEdit).toHaveBeenCalledWith({ changes: {} });
  });
});

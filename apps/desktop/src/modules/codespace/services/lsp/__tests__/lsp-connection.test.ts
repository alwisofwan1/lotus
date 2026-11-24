import { describe, expect, it, vi } from "vitest";
import { LSP_ERRORS, LspConnection, LspConnectionClosedError, LspRequestError } from "../lsp-connection";

function setup() {
  const sent: Array<Record<string, unknown>> = [];
  const connection = new LspConnection({
    send: async (message) => {
      sent.push(JSON.parse(message) as Record<string, unknown>);
    },
  });
  return { connection, sent };
}

describe("LspConnection", () => {
  it("matches an answer to its request", async () => {
    const { connection, sent } = setup();
    const answer = connection.request<{ ok: boolean }>("textDocument/hover", { a: 1 });
    await Promise.resolve();
    expect(sent[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "textDocument/hover", params: { a: 1 } });
    connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    await expect(answer).resolves.toEqual({ ok: true });
  });

  it("rejects with the server's error", async () => {
    const { connection } = setup();
    const answer = connection.request("x");
    connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "bad" } }));
    await expect(answer).rejects.toEqual(new LspRequestError(-32602, "bad"));
  });

  it("cancels a request and tells the server", async () => {
    const { connection, sent } = setup();
    const controller = new AbortController();
    const answer = connection.request("textDocument/completion", {}, controller.signal);
    controller.abort();
    await expect(answer).rejects.toMatchObject({ code: LSP_ERRORS.requestCancelled });
    await Promise.resolve();
    expect(sent.at(-1)).toMatchObject({ method: "$/cancelRequest", params: { id: 1 } });
    // A late answer is ignored.
    connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1 }));
  });

  it("answers a server request with the handler's result", async () => {
    const { connection, sent } = setup();
    connection.onRequest("workspace/configuration", () => [null]);
    connection.receive(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "workspace/configuration", params: { items: [{}] } }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: 7, result: [null] });
  });

  it("answers MethodNotFound for a request it does not know", async () => {
    const { connection, sent } = setup();
    connection.receive(JSON.stringify({ jsonrpc: "2.0", id: "a", method: "unknown/thing" }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ id: "a", error: { code: LSP_ERRORS.methodNotFound } });
  });

  it("hands notifications to their handler and ignores noise", () => {
    const { connection } = setup();
    const handler = vi.fn();
    connection.onNotification("window/logMessage", handler);
    connection.receive("not json");
    connection.receive(JSON.stringify({ jsonrpc: "2.0", method: "window/logMessage", params: { message: "hi" } }));
    expect(handler).toHaveBeenCalledWith({ message: "hi" });
  });

  it("fails open requests on close and sends nothing after", async () => {
    const { connection, sent } = setup();
    const answer = connection.request("x");
    connection.close();
    await expect(answer).rejects.toBeInstanceOf(LspConnectionClosedError);
    await expect(connection.request("y")).rejects.toBeInstanceOf(LspConnectionClosedError);
    connection.notify("z");
    await Promise.resolve();
    expect(sent.map((message) => message.method)).toEqual(["x"]);
  });
});

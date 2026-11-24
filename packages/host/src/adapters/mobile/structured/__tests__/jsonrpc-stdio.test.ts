import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { JsonRpcError, JsonRpcStdio } from "../jsonrpc-stdio.js";

function pair() {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const sent: string[] = [];
  toServer.on("data", (c: Buffer) => sent.push(...c.toString().split("\n").filter(Boolean)));
  const rpc = new JsonRpcStdio(fromServer, toServer);
  const serverSays = (o: object) => fromServer.write(`${JSON.stringify(o)}\n`);
  return { rpc, sent, serverSays };
}

describe("JsonRpcStdio", () => {
  it("correlates a response to its request by id and omits the jsonrpc header on the wire", async () => {
    const { rpc, sent, serverSays } = pair();
    const p = rpc.request("initialize", { a: 1 });
    await new Promise((r) => setTimeout(r, 5));
    expect(JSON.parse(sent[0] ?? "{}")).toEqual({ id: 0, method: "initialize", params: { a: 1 } });
    serverSays({ id: 0, result: { userAgent: "x" } });
    await expect(p).resolves.toEqual({ userAgent: "x" });
  });

  it("turns a server error into a JsonRpcError carrying the code", async () => {
    const { rpc, serverSays } = pair();
    const p = rpc.request("thread/start", {});
    await new Promise((r) => setTimeout(r, 5));
    serverSays({ id: 0, error: { code: -32600, message: "Invalid request" } });
    await expect(p).rejects.toBeInstanceOf(JsonRpcError);
  });

  it("dispatches a line with method and no id as a notification", async () => {
    const { rpc, serverSays } = pair();
    const seen: string[] = [];
    rpc.onNotification((n) => seen.push(n.method));
    serverSays({ method: "turn/started", params: {} });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual(["turn/started"]);
  });

  it("answers a server request — a line with both id and method — with the handler's result on the same id", async () => {
    const { rpc, sent, serverSays } = pair();
    rpc.onServerRequest(async (req) => ({ decision: req.method === "item/commandExecution/requestApproval" ? "accept" : "decline" }));
    serverSays({ id: 7, method: "item/commandExecution/requestApproval", params: { command: "ls" } });
    await new Promise((r) => setTimeout(r, 5));
    expect(JSON.parse(sent.at(-1) ?? "{}")).toEqual({ id: 7, result: { decision: "accept" } });
  });

  it("reassembles a line split across chunks and ignores non-JSON noise", async () => {
    const { rpc, serverSays } = pair();
    const seen: string[] = [];
    rpc.onNotification((n) => seen.push(n.method));
    const fromServer = (rpc as unknown as { input: PassThrough }).input;
    fromServer.write("warning: something\n");
    fromServer.write('{"method":"a/b"');
    fromServer.write(',"params":{}}\n');
    serverSays({ method: "c/d" });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual(["a/b", "c/d"]);
  });
});

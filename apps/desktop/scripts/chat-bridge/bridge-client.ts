// A small host for the chat bridge, used by the live scripts (smoke test, fixture recorder).
// The real host is Rust (phase 2); this one only exists to drive the bridge from a terminal.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const MINIMAL_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const STEP_TIMEOUT_MS = 180_000;

// Script-only: wire messages are read loosely here; main.ts validates the real inbound path.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export interface BridgeClientOptions {
  // PATH like a GUI app launched from Finder.
  minimalPath: boolean;
  // Every line the bridge writes, before any handling.
  onRawLine?: (line: string) => void;
  // Also receive the untranslated SDK messages as `thread/raw`.
  raw?: boolean;
}

export function startBridgeClient(options: BridgeClientOptions) {
  const env = {
    ...process.env,
    ...(options.minimalPath ? { PATH: MINIMAL_PATH } : {}),
    ...(options.raw ? { LOTUS_CHAT_BRIDGE_RAW: "1" } : {}),
  };
  // LOTUS_CHAT_BRIDGE_BIN points at a `bun build --compile` binary, to test what a release would ship.
  const compiledBridge = process.env.LOTUS_CHAT_BRIDGE_BIN;
  const [command, args] = compiledBridge
    ? [compiledBridge, []]
    : [process.execPath, ["run", join(dirname(fileURLToPath(import.meta.url)), "main.ts")]];
  const bridge = spawn(command, args, { env, stdio: ["pipe", "pipe", "inherit"] });

  const waiters = new Map<string | number, (message: Json) => void>();
  const listeners = new Set<(message: Json) => void>();
  const approvalsSeen: Json[] = [];
  let nextId = 1;
  let approvalPolicy: (request: Json) => Json = () => ({ behavior: "deny", message: "no approval expected" });

  function send(message: Json): void {
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  createInterface({ input: bridge.stdout }).on("line", (line) => {
    options.onRawLine?.(line);
    const message = JSON.parse(line) as Json;
    if (message.method === "interaction/request") {
      approvalsSeen.push(message.params);
      send({ id: message.id, result: approvalPolicy(message.params) });
      return;
    }
    if ("id" in message && !("method" in message)) {
      waiters.get(message.id)?.(message);
      waiters.delete(message.id);
      return;
    }
    for (const listener of listeners) listener(message);
  });

  function request(method: string, params: Json): Promise<Json> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      waiters.set(id, (reply) => (reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result)));
      send({ id, method, params });
    });
  }

  function waitFor(predicate: (message: Json) => boolean, label: string): Promise<Json> {
    return new Promise((resolve, reject) => {
      const listener = (message: Json) => {
        if (!predicate(message)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(message);
      };
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`timeout waiting for ${label}`));
      }, STEP_TIMEOUT_MS);
      listeners.add(listener);
    });
  }

  return {
    request,
    waitFor,
    approvalsSeen,
    listen(listener: (message: Json) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setApprovalPolicy(policy: (request: Json) => Json): void {
      approvalPolicy = policy;
    },
    close(): void {
      bridge.stdin.end();
    },
  };
}

// Untranslated SDK messages (needs `raw: true`).
export const isSdkEvent = (type: string) => (m: Json) => m.method === "thread/raw" && m.params.event.type === type;

export const isTextDelta = (m: Json) =>
  m.method === "thread/raw" &&
  m.params.event.type === "stream_event" &&
  m.params.event.event?.delta?.type === "text_delta";

// Translated ThreadEvents.
export const isThreadEvent = (type: string) => (m: Json) => m.method === "thread/event" && m.params.event.type === type;

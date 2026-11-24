import type { IncomingMessage, ServerResponse } from "node:http";
import type { HealthResponse } from "../../types/index.js";

export function healthHandler(port: number): (req: IncomingMessage, res: ServerResponse) => void {
  const body: HealthResponse = { ok: true, port, version: "0.1.0" };
  const encoded = JSON.stringify(body);
  return (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(encoded);
  };
}

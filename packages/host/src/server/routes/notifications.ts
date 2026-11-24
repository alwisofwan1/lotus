import type { IncomingMessage, ServerResponse } from "node:http";
import type { NotificationBus } from "../notifications/bus.js";
import type { RouteHandler } from "../router.js";

const PING_INTERVAL_MS = 30_000;

export function notificationStreamHandler(bus: NotificationBus): RouteHandler {
  return (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Flush headers to the client immediately so the response is readable.
    res.write(": connected\n\n");

    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(pingInterval);
      if (!res.writableEnded) res.end();
    };

    const unsubscribe = bus.subscribe((event) => {
      if (res.writableEnded) { cleanup(); return; }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    const pingInterval = setInterval(() => {
      if (res.writableEnded) { cleanup(); return; }
      res.write(": ping\n\n");
    }, PING_INTERVAL_MS);

    req.on("close", cleanup);
    res.on("error", cleanup);
  };
}

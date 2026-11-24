import type { IncomingMessage, ServerResponse } from "node:http";

import { createLogger } from "../core/logger.js";

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>
) => void | Promise<void>;

interface Route {
  method: string;
  path: string;
  regex: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

/** A registered route, as the contract guard needs to see it. */
export interface RouteDescriptor {
  method: string;
  path: string;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): this {
    const { regex, paramNames } = buildPattern(path);
    this.routes.push({ method: method.toUpperCase(), path, regex, paramNames, handler });
    return this;
  }

  list(): RouteDescriptor[] {
    return this.routes.map(({ method, path }) => ({ method, path }));
  }

  dispatch(req: IncomingMessage, res: ServerResponse): boolean {
    const method = req.method?.toUpperCase() ?? "GET";
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.regex.exec(pathname);
      if (!match) continue;

      const params: Record<string, string> = {};
      try {
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1] ?? "");
        });
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid URL parameter" }));
        return true;
      }

      void Promise.resolve(route.handler(req, res, params)).catch((err: unknown) => {
        // Said out loud. A handler that throws used to become a bare 500 with the reason
        // discarded, which on a headless host means the only copy of it is gone: there is
        // no console to look at, and `journalctl` shows a request that simply failed.
        // Cost two diagnosis rounds on 2026-09-05, and the comment in `cell-routes.ts`
        // about "a 400 naming permissionMode died as a bare 500" is the same wound.
        createLogger().error("route.threw", {
          method,
          path: route.path,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
          ...(err instanceof Error && err.stack !== undefined ? { stack: err.stack.split("\n").slice(0, 4).join(" | ") } : {}),
        });
        if (!res.writableEnded) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal Server Error" }));
        }
      });

      return true;
    }

    return false;
  }
}

function buildPattern(path: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const regexStr = path
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
      paramNames.push(name);
      return "([^/]+)";
    });
  return { regex: new RegExp(`^${regexStr}$`), paramNames };
}

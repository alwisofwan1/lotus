import type { Server } from "node:http";

/**
 * What to try when binding the mobile façade fails (`EADDRINUSE`, `EADDRNOTAVAIL`).
 * A stale stored LAN address (new DHCP lease) fails the bind non-fatally: the runtime stays
 * up with nothing listening.
 */
export function bindFailureHint(code: string | undefined, host: string): string | undefined {
  switch (code) {
    case "EADDRINUSE":
      return "another host runtime may still be holding the port";
    case "EADDRNOTAVAIL":
      return (
        `${host} is not on any interface of this machine — its IP has probably ` +
        "changed since it was chosen; pick the current one in Settings → Mobile " +
        "access → Listen on"
      );
    default:
      return undefined;
  }
}

/** Binds, or warns why not and resolves false: `address()` then answers null, which `/admin/health` reads as "not bound". */
export function listenOrWarn(
  server: Server,
  bind: { host: string; port: number },
  warn: (event: string, fields: Record<string, unknown>) => void,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      warn("mobile.bind_failed", { host: bind.host, port: bind.port, code: error.code ?? "unknown", hint: bindFailureHint(error.code, bind.host) });
      resolve(false);
    };
    server.once("error", onError);
    server.listen(bind.port, bind.host, () => {
      server.removeListener("error", onError);
      resolve(true);
    });
  });
}

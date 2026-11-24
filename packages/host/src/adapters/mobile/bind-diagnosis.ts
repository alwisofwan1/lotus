import type { Server } from "node:http";

/**
 * What to try, for the two ways binding the mobile façade actually fails.
 *
 * Its own module because `index.ts` is at the 300-line limit, and because this is a
 * pure question — an errno and an address in, a next move out — that reads better away
 * from the listener plumbing.
 *
 * `EADDRNOTAVAIL` is the one that was missing, and it is the likelier of the two on a
 * laptop: the operator picks a LAN address in Settings, it is stored, and the next DHCP
 * lease or a different Wi-Fi gives the machine a new one. The stored address then
 * belongs to no interface, the bind fails, and — because a failed bind is deliberately
 * non-fatal, so PTYs and MCP keep working — the runtime stays up with nothing
 * listening.
 *
 * That is the failure mode `MobileTab`'s own copy warns about ("a host that is UP …
 * where every indicator reads healthy and no phone can route to it"), except worse:
 * here even the runtime process is alive, so nothing on the desktop looks wrong.
 *
 * Measured 2026-08-07 while trying to test Chat on a real phone: `10.229.135.108` in
 * the config, `192.168.1.11` on `en0`, host runtime alive, port 8787 dead, a paired
 * phone reaching nothing. Time went into chasing Chat when there was no transport.
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

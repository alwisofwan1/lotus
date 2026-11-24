import { describe, it, expect } from "vitest";
import { APPROVAL_SERVER_FLAG, selfInvocation } from "../approval-script.js";

/// How this host re-invokes itself as the approval MCP server.
///
/// `approval-host.ts` used to hand `claude` a `.mjs` file and `process.execPath` to run it
/// with. On a compiled binary that is a command that ignores its argument and starts a second
/// Lotus host, so `mcp__lotus__approve` never registered and every approval — not only
/// `AskUserQuestion` — was refused instead of asked. Issue 26 of `plans/pocket-without-laptop`.
describe("selfInvocation", () => {
  it("re-invokes a compiled binary as itself", () => {
    // What the VPS runs: `/usr/local/bin/lotus-host`, no script anywhere in argv.
    expect(selfInvocation("/usr/local/bin/lotus-host", ["/usr/local/bin/lotus-host"])).toEqual({
      command: "/usr/local/bin/lotus-host",
      args: [APPROVAL_SERVER_FLAG],
    });
  });

  it("re-invokes a bundled script through the same runtime that is running it", () => {
    // What the desktop bundle and the Telegram unit do: `node <bundle>.mjs`.
    expect(
      selfInvocation("/usr/bin/node", ["/usr/bin/node", "/opt/lotus/dist/lotus-remote.mjs"]),
    ).toEqual({
      command: "/usr/bin/node",
      args: ["/opt/lotus/dist/lotus-remote.mjs", APPROVAL_SERVER_FLAG],
    });
  });

  it("ignores arguments that are not the script it was started from", () => {
    // A host started with flags of its own must not pass them on: the child is an MCP
    // server, and `--verbose` there is a flag it does not know.
    expect(
      selfInvocation("/usr/bin/node", ["/usr/bin/node", "/opt/app.mjs", "--verbose", "x.mjs"]),
    ).toEqual({ command: "/usr/bin/node", args: ["/opt/app.mjs", APPROVAL_SERVER_FLAG] });
  });

  it("falls back to the binary shape when argv says nothing useful", () => {
    // Bun's compiled binaries have been seen with a `/$bunfs/` entry rather than a real
    // path. Anything that is not a readable script is treated as "I am the command".
    expect(selfInvocation("/usr/local/bin/lotus-host", [])).toEqual({
      command: "/usr/local/bin/lotus-host",
      args: [APPROVAL_SERVER_FLAG],
    });
  });
});

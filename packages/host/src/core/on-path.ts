import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Share binary discovery here so adapters and server routes do not depend on each other. */
export function onPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const exe = process.platform === "win32" ? `${command}.exe` : command;
  return (env["PATH"] ?? "").split(delimiter).some((dir) => dir !== "" && existsSync(join(dir, exe)));
}

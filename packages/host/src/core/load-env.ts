import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Keep the local file optional so deployments can supply environment variables directly. */
export function loadEnv(filePath = ".env"): void {
  const abs = resolve(process.cwd(), filePath);
  if (!existsSync(abs)) return;
  process.loadEnvFile(abs);
}

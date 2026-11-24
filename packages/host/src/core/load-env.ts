import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Loads a `.env` file using Node's built-in `process.loadEnvFile()`.
 *
 * Why this over the `--env-file` flag or the `dotenv` package:
 * - Native API (Node ≥20.12), no extra dependency.
 * - Works regardless of how the script is invoked (node, tsx, bun, etc.).
 * - Already-defined env vars take precedence — does NOT overwrite them.
 *   This is the right default: real env (CI, systemd, k8s, shell exports)
 *   should always win over the local file.
 *
 * The file is optional — if it does not exist, this is a no-op. That's
 * intentional: in production env vars come from the orchestrator, not a
 * checked-in `.env`.
 */
export function loadEnv(filePath = ".env"): void {
  const abs = resolve(process.cwd(), filePath);
  if (!existsSync(abs)) return;
  process.loadEnvFile(abs);
}

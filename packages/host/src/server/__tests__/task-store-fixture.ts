import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SwarmTaskStore } from "../tasks/store.js";

/**
 * A SwarmTaskStore backed by a throwaway temp dir — for route tests that need
 * to satisfy `AppDeps` but do not exercise the `/v1/tasks/*` surface.
 */
export function makeTestTaskStore(): SwarmTaskStore {
  return new SwarmTaskStore({ baseDir: mkdtempSync(join(tmpdir(), "lotus-tasks-test-")) });
}

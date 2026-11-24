import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

export const FIXTURES = join(HERE, "../../../../../../../contract/fixtures");

/** Set to regenerate the committed fixtures from live handler output. */
const WRITE = process.env["UPDATE_CONTRACT_FIXTURES"] === "1";

/**
 * Compares handler output against the committed fixture, or rewrites it when
 * `UPDATE_CONTRACT_FIXTURES=1`.
 *
 * Shared so both contract test files regenerate identically — a second copy of
 * this would drift in formatting and produce fixture diffs nobody asked for.
 */
export function assertFixture(name: string, actual: unknown): void {
  const path = join(FIXTURES, `${name}.json`);
  const body = `${JSON.stringify(actual, null, 2)}\n`;
  if (WRITE) {
    mkdirSync(FIXTURES, { recursive: true });
    writeFileSync(path, body, "utf8");
    return;
  }
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(actual);
}

#!/usr/bin/env node
// Linux host binaries for a release (plans/managed-host): what Lotus installs on an SSH machine.
//
//   bun scripts/build-host-release.mjs 0.17.0     build both, print the files
//
// Each binary embeds its arch's lotus-sessiond and is stamped with the app version, which the
// Managed Host health check compares against. release-macos.mjs calls this before the app build,
// so a release can never ship without a host that matches it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hostDir = resolve(fileURLToPath(new URL("../../../packages/host", import.meta.url)));
export const HOST_ARCHES = ["x64", "arm64"];

export function buildHostRelease(version) {
  const files = [];
  for (const arch of HOST_ARCHES) {
    const sessiond = join("dist", `lotus-sessiond-linux-${arch}`);
    if (!existsSync(join(hostDir, sessiond)))
      throw new Error(`${join(hostDir, sessiond)} is missing: run apps/desktop/scripts/build-sessiond-linux.sh`);
    const name = `lotus-host-linux-${arch}`;
    const out = join(hostDir, "dist", name);
    const r = spawnSync(
      "bun",
      ["build", "src/index.ts", sessiond, "--compile", `--target=bun-linux-${arch}`, "--define", `LOTUS_BUILD_ID="${version}"`, `--outfile=${out}`],
      { cwd: hostDir, stdio: "inherit" },
    );
    if (r.error || r.status !== 0) throw new Error(`host build for linux-${arch} failed (${r.error?.message ?? `exit ${r.status}`})`);
    // `sha256sum` format: the machine compares only the first field.
    writeFileSync(`${out}.sha256`, `${createHash("sha256").update(readFileSync(out)).digest("hex")}  ${name}\n`);
    files.push(out, `${out}.sha256`);
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
    console.error("usage: build-host-release.mjs <x.y.z>");
    process.exit(1);
  }
  for (const f of buildHostRelease(version)) console.log(f);
}

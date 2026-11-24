import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Copies bundled integration skills (the repo's `lotus-remote/skills/*`) into the
 * Remote-Scoped Skills mount so the agent auto-discovers them via `--add-dir`
 * (ADR-0018). Non-destructive: a skill the operator has already placed/edited in
 * the mount is never overwritten. Returns the names of skills newly seeded.
 */
export function seedRemoteSkills(seedDir: string, mount: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(seedDir);
  } catch {
    return []; // nothing bundled (e.g. running from a build without seeds)
  }

  const skillsRoot = join(mount, ".claude", "skills");
  mkdirSync(skillsRoot, { recursive: true });

  const seeded: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const src = join(seedDir, name);
    const dest = join(skillsRoot, name);
    try {
      if (!statSync(src).isDirectory()) continue;
      if (existsSync(dest)) continue; // operator owns it
      cpSync(src, dest, { recursive: true });
      seeded.push(name);
    } catch {
      // skip a skill that vanished or failed to copy — best-effort seeding
    }
  }
  return seeded;
}

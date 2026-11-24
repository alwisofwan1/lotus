import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";

interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  hasPackageJson: boolean;
}

interface ProjectMeta {
  id: string;
  path: string;
  name: string;
  lastUsed?: string;
}

export async function GET(req: NextRequest) {
  const browse = req.nextUrl.searchParams.get("browse");

  // browse mode: used by listDirEntries() REST fallback
  if (browse !== null) {
    const target = path.resolve(browse || "/");
    try {
      const entries = fs.readdirSync(target, { withFileTypes: true });
      const dirs: DirEntry[] = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => {
          const fullPath = path.join(/* turbopackIgnore: true */ target, e.name);
          const isGitRepo = fs.existsSync(path.join(/* turbopackIgnore: true */ fullPath, ".git"));
          const hasPackageJson = fs.existsSync(path.join(/* turbopackIgnore: true */ fullPath, "package.json"));
          return { name: e.name, path: fullPath, isGitRepo, hasPackageJson };
        });
      return NextResponse.json(dirs);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to read directory";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  // no browse param: list_projects — reads Claude Code project history
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(projectsDir)) return NextResponse.json([]);

  try {
    const items: ProjectMeta[] = fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const dirName = e.name;
        const decoded = "/" + dirName.replace(/-/g, "/");
        const fullPath = path.join(projectsDir, dirName);
        let lastUsed: string | undefined;
        try {
          const stat = fs.statSync(fullPath);
          lastUsed = stat.mtime.toISOString();
        } catch { /* ignore */ }
        const name = path.basename(decoded) || dirName;
        return { id: dirName, path: decoded, name, lastUsed };
      });

    items.sort((a, b) => (b.lastUsed ?? "").localeCompare(a.lastUsed ?? ""));
    return NextResponse.json(items);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list projects";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

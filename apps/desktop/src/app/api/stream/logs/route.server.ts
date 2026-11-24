import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";

export async function GET() {
  const logsDir = path.join(os.homedir(), ".claude", "agent-teams-logs");
  if (!fs.existsSync(logsDir)) return NextResponse.json([]);

  try {
    const teamsDir = path.join(os.homedir(), ".claude", "teams");
    const entries = fs
      .readdirSync(logsDir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => {
        const teamId = f.replace(/\.log$/, "");
        const filePath = path.join(logsDir, f);
        let size = 0;
        let modifiedAt: string | null = null;
        try {
          const stat = fs.statSync(filePath);
          size = stat.size;
          modifiedAt = stat.mtime.toISOString();
        } catch { /* ignore */ }

        let teamName: string | null = null;
        try {
          const cfg = JSON.parse(
            fs.readFileSync(path.join(teamsDir, teamId, "config.json"), "utf-8")
          );
          teamName = cfg.name ?? null;
        } catch { /* ignore */ }

        return { teamId, teamName, size, modifiedAt };
      })
      .sort((a, b) => (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? ""));

    return NextResponse.json(entries);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list logs";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

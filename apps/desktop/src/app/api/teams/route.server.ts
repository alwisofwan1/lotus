import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { lotusTeamsDir } from "@/app/api/_lotus-state";

function teamsDir() {
  return lotusTeamsDir();
}

export async function GET() {
  const dir = teamsDir();
  if (!fs.existsSync(dir)) return NextResponse.json([]);
  try {
    const teams = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((e) => {
        const cfgPath = path.join(dir, e.name, "config.json");
        try {
          const t = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
          return t.id ? [t] : [];
        } catch {
          return [];
        }
      });
    return NextResponse.json(teams);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to list teams";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const config = body.config ?? body;
    const cfgPath = path.join(teamsDir(), config.id, "config.json");
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create team";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

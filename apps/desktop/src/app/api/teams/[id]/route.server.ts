import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { lotusTasksDir, lotusTeamsDir } from "@/app/api/_lotus-state";

function teamsDir() {
  return lotusTeamsDir();
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const cfgPath = path.join(teamsDir(), id, "config.json");
  if (!fs.existsSync(cfgPath)) return NextResponse.json(null);
  try {
    return NextResponse.json(JSON.parse(fs.readFileSync(cfgPath, "utf-8")));
  } catch {
    return NextResponse.json(null);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await req.json();
    const config = body.config ?? body;
    if (id !== config.id) {
      return NextResponse.json({ error: "id mismatch" }, { status: 400 });
    }
    const cfgPath = path.join(teamsDir(), id, "config.json");
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2));
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update team";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const teamPath = path.join(teamsDir(), id);
    if (fs.existsSync(teamPath)) fs.rmSync(teamPath, { recursive: true });
    const tasksPath = lotusTasksDir(id);
    if (fs.existsSync(tasksPath)) fs.rmSync(tasksPath, { recursive: true });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to delete team";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
